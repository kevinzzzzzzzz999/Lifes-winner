"""Local IPython cell host. Wire messages use fd 3, separate from user streams.

This is a desktop execution process, not a Jupyter server or a security sandbox.
Only the host's explicit run request executes notebook source.
"""
import sys, os, json, traceback, io, builtins, threading, time
packages, original, state_dir, memory_bytes = sys.argv[1:5]
sys.path.insert(0, packages)
os.environ['IPYTHONDIR'] = os.path.join(state_dir, 'ipython')
cache_dir = os.path.join(os.path.dirname(os.path.dirname(state_dir)), 'notebook-cache')
os.makedirs(cache_dir, exist_ok=True)
os.environ['MPLCONFIGDIR'] = os.path.join(cache_dir, 'matplotlib')
os.environ['XDG_CACHE_HOME'] = cache_dir
os.environ['MPLBACKEND'] = 'module://matplotlib_inline.backend_inline'
os.environ['OPENBLAS_NUM_THREADS'] = '1'
os.environ['OMP_NUM_THREADS'] = '1'
wire = os.fdopen(3, 'w', encoding='utf-8', buffering=1)
lock = threading.RLock()
active = None
output_bytes = 0
output_count = 0
max_output = 4 * 1024 * 1024

def send(kind, **values):
    with lock:
        data = {'kind': kind, **values}
        if active:
            data['runId'] = active['runId']
            if 'cellIndex' in active:
                data['cellIndex'] = active['cellIndex']
        wire.write(json.dumps(data, ensure_ascii=False, default=str) + '\n')
        wire.flush()

def output(value):
    global output_bytes, output_count
    if not active:
        return
    payload = json.dumps(value, ensure_ascii=False, default=str)
    output_bytes += len(payload.encode('utf-8'))
    output_count += 1
    if output_bytes > max_output or output_count > 4000:
        send('limit', reason='output_limit')
        os._exit(70)
    send('output', output=value)

class Stream(io.TextIOBase):
    def __init__(self, name): self.name = name
    def writable(self): return True
    def isatty(self): return False
    @property
    def encoding(self): return 'utf-8'
    def write(self, text):
        if not isinstance(text, str): text = str(text)
        for start in range(0, len(text), 8192):
            output({'output_type': 'stream', 'name': self.name, 'text': text[start:start + 8192]})
        return len(text)
    def flush(self): pass

from IPython.core.interactiveshell import InteractiveShell
from IPython.core.displaypub import DisplayPublisher
from traitlets.config import Config

class Publisher(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kwargs):
        # Widget/javascript MIME is retained only as a plain-text explanation;
        # app output views support safe HTML and PNG/JPEG, not executable widgets.
        safe = {key: value for key, value in data.items() if key in ('text/plain', 'text/html', 'image/png', 'image/jpeg', 'text/latex', 'application/json')}
        if not safe: safe = {'text/plain': '[This output needs an interactive Jupyter extension.]'}
        output({'output_type': 'display_data', 'data': safe, 'metadata': metadata or {}})
    def clear_output(self, wait=False):
        if active: send('clear-output', wait=bool(wait))

config = Config()
config.HistoryManager.enabled = False
config.InteractiveShell.colors = 'nocolor'
config.InteractiveShell.cache_size = 100
config.InteractiveShell.display_pub_class = Publisher
shell = InteractiveShell.instance(config=config, user_ns={'__name__': '__main__', '__file__': original})
shell.display_pub = Publisher(parent=shell)
shell.displayhook.write_output_prompt = lambda: None

def result_output(data, md=None):
    safe = {key: value for key, value in data.items() if key in ('text/plain', 'text/html', 'image/png', 'image/jpeg', 'text/latex', 'application/json')}
    output({'output_type': 'execute_result', 'execution_count': active.get('executionCount') if active else None,
            'data': safe, 'metadata': md or {}})
shell.displayhook.write_format_data = result_output
# run_cell returns the real exception. Produce structured nbformat error output once.
shell.showtraceback = lambda *args, **kwargs: None
shell.showsyntaxerror = lambda *args, **kwargs: None
shell.showindentationerror = lambda *args, **kwargs: None
# Never read a command from the wire as a notebook input() reply.
def no_input(*args, **kwargs):
    raise RuntimeError('Interactive input() is not supported yet; assign the value in a cell instead.')
builtins.input = no_input
import getpass
getpass.getpass = no_input
# Enable notebook-style inline plots before notebook-directory modules can shadow
# the trusted runtime imports. User local imports remain supported afterwards.
def enable_gui(gui=None):
    if gui not in (None, 'inline'):
        raise RuntimeError('This local notebook supports inline figures. Use %matplotlib inline.')
shell.enable_gui = enable_gui
shell.enable_matplotlib('inline')
sys.path.append(os.path.dirname(original))
import psutil
process = psutil.Process()
limit = int(memory_bytes)
def watch_memory():
    while True:
        time.sleep(1)
        try:
            rss = process.memory_info().rss
            # macOS can deny process-list enumeration while allowing the kernel
            # to read its own RSS. Do not skip the primary budget in that case.
            try:
                for child in process.children(recursive=True):
                    try: rss += child.memory_info().rss
                    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError): pass
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError): pass
            if rss > limit:
                send('limit', reason='memory_limit')
                os._exit(71)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError): pass
threading.Thread(target=watch_memory, daemon=True).start()
# Disable stdin in user code, retaining a private handle for trusted commands.
commands = sys.stdin
sys.stdin = io.StringIO('')
sys.stdout, sys.stderr = Stream('stdout'), Stream('stderr')
send('ready', python=sys.version.split()[0])
for line in commands:
    try:
        request = json.loads(line)
        active = {'runId': request['runId']}
        output_bytes = output_count = 0
        status = 'ok'
        for cell in request['cells']:
            active['cellIndex'] = cell['index']
            count = shell.execution_count
            active['executionCount'] = count
            send('cell-start', executionCount=count)
            result = shell.run_cell(cell['source'], store_history=True, cell_id=str(cell['index']))
            error = result.error_before_exec or result.error_in_exec
            if error:
                output({'output_type': 'error', 'ename': type(error).__name__, 'evalue': str(error),
                        'traceback': traceback.format_exception(type(error), error, error.__traceback__)})
            send('cell-end', executionCount=count, status='error' if error else 'ok')
            if error:
                status = 'error'
                break
        send('run-end', status=status, reason='completed' if status == 'ok' else 'error')
    except KeyboardInterrupt:
        send('run-end', status='error', reason='cancelled')
    except BaseException as error:
        if active:
            output({'output_type': 'error', 'ename': type(error).__name__, 'evalue': str(error), 'traceback': traceback.format_exception(error)})
        send('run-end', status='error', reason='error')
    finally:
        active = None
