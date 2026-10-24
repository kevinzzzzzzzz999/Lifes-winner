"""Record every managed runtime file and copy wheel licenses for packaging."""
from pathlib import Path
import hashlib, json, shutil, email
root=Path(__file__).resolve().parents[2];base=root/'runtime/notebook';runtime=base/'darwin-arm64';licenses=root/'LICENSES/notebook';licenses.mkdir(parents=True,exist_ok=True)
records=[]
for dist in sorted(runtime.glob('*.dist-info')):
    metadata=email.message_from_bytes((dist/'METADATA').read_bytes());copied=[]
    for f in sorted(dist.rglob('*')):
        if f.is_file() and ('licenses' in f.relative_to(dist).parts or f.name.lower().startswith(('license','copying','notice','copyright'))):
            dest=licenses/dist.name/f.relative_to(dist);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,dest);copied.append(str(dest.relative_to(root)))
    if not copied: raise SystemExit('No license files: '+dist.name)
    records.append({'name':str(metadata['Name']),'version':str(metadata['Version']),'licenseFiles':copied})
# pip's generated launchers have source-specific absolute shebangs, and aren't used
# by the app. The app invokes kernel.py with its own bundled interpreter.
shutil.rmtree(runtime/'bin',ignore_errors=True)
files={}
for f in sorted(runtime.rglob('*')):
    if f.is_symlink(): raise SystemExit('Unexpected runtime symlink: '+str(f))
    if f.is_file() and '__pycache__' not in f.parts and f.suffix!='.pyc':
        b=f.read_bytes();files[str(f.relative_to(base))]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
(base/'FILES.json').write_text(json.dumps({'schemaVersion':1,'scope':'Exact unpacked official wheel bytes; executables signed separately by the development build.', 'files':files},indent=2)+'\n')
(licenses/'index.json').write_text(json.dumps({'schemaVersion':1,'packages':records},indent=2)+'\n')
(base/'PROVENANCE.json').write_text(json.dumps({
    'schemaVersion':1,
    'platform':'darwin-arm64',
    'python':'3.14.7',
    'source':'SHA-256-pinned public wheels listed in requirements-darwin-arm64.lock',
    'packages':[{'name':p['name'],'version':p['version'],'licenseFiles':p['licenseFiles']} for p in records]
},indent=2)+'\n')
print(json.dumps({'runtimeFiles':len(files),'packages':len(records),'licenseFiles':sum(len(p['licenseFiles']) for p in records),'totalBytes':sum(p['bytes'] for p in files.values())}))
