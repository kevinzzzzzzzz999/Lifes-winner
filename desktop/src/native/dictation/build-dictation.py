#!/usr/bin/env python3
"""Build/sign the on-device dictation helper; never installs or starts recording."""
from pathlib import Path
import argparse,subprocess,plistlib,hashlib,json
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--identity',default='-');args=p.parse_args()
src=Path(__file__).resolve().parent;app=args.output;exe=app/'Contents/MacOS/InkSpaceDictation';exe.parent.mkdir(parents=True,exist_ok=True)
sdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
subprocess.run(['xcrun','swiftc','-swift-version','5','-O','-target','arm64-apple-macos26.0','-sdk',sdk,'-module-cache-path','/private/tmp/inkspace109-dictation-module-cache',str(src/'DictationTranscript.swift'),str(src/'InkSpaceDictation.swift'),'-o',str(exe)],check=True)
info={'CFBundleIdentifier':'org.inkspace.quick-note-dictation','CFBundleExecutable':'InkSpaceDictation','CFBundleName':'人生赢家语音便签','CFBundleDisplayName':"Life's Winner Voice Notes",'CFBundleVersion':'121','CFBundlePackageType':'APPL','LSUIElement':True,'LSMinimumSystemVersion':'26.0','NSMicrophoneUsageDescription':'将您主动说出的内容转为便签草稿，不保存录音。','NSSpeechRecognitionUsageDescription':'使用Apple本机语音识别，将您说出的内容转为便签草稿。'}
info.update({'CFBundleDevelopmentRegion':'en','CFBundleLocalizations':['en','zh','zh-Hans','zh-Hant']})
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
for brand_locale in ['en','zh','zh-Hans','zh-Hant']:
 brand_name="Life's Winner Voice Notes" if brand_locale=='en' else '人生赢家语音便签'
 brand_fields={'CFBundleDisplayName':brand_name}
 if brand_locale=='en':brand_fields.update({'NSMicrophoneUsageDescription':'Turns speech you choose to record into a voice-note draft without saving audio.','NSSpeechRecognitionUsageDescription':'Uses Apple on-device speech recognition to turn your spoken words into a note draft.'})
 brand_file=app/'Contents/Resources'/f'{brand_locale}.lproj'/'InfoPlist.strings'
 brand_file.parent.mkdir(parents=True,exist_ok=True)
 brand_file.write_text('\n'.join(json.dumps(key)+' = '+json.dumps(value,ensure_ascii=False)+';' for key,value in brand_fields.items())+'\n',encoding='utf-8')

ent=app.parent/'dictation-entitlements.plist';ent.write_bytes(plistlib.dumps({'com.apple.security.device.audio-input':True}))
subprocess.run(['/usr/bin/codesign','--force','--sign',args.identity,'--timestamp=none','--entitlements',str(ent),str(app)],check=True)
print(json.dumps({'app':str(app),'executable':str(exe),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'minimumMacOS':'26.0','recordingStarted':False}))
