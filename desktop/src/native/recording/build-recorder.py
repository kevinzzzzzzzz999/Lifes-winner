#!/usr/bin/env python3
"""Compile/sign the isolated PCM recorder. Never starts it or requests microphone access."""
from pathlib import Path
import argparse,subprocess,plistlib,json,hashlib
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--identity',default='-');a=p.parse_args()
app=a.output;exe=app/'Contents/MacOS/RecognitionRecorder';exe.parent.mkdir(parents=True,exist_ok=True)
sdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
subprocess.run(['xcrun','swiftc','-swift-version','5','-O','-target','arm64-apple-macos13.0','-sdk',sdk,'-module-cache-path','/private/tmp/inkspace118-recorder-module-cache',str(Path(__file__).with_name('RecognitionRecorder.swift')),'-o',str(exe)],check=True)
info={'CFBundleIdentifier':'org.inkspace.recognition-recorder','CFBundleExecutable':'RecognitionRecorder','CFBundleName':'RecognitionRecorder','CFBundleDisplayName':"Life's Winner Sample Recorder",'CFBundleVersion':'118','CFBundlePackageType':'APPL','LSUIElement':True,'LSMinimumSystemVersion':'13.0','CFBundleDevelopmentRegion':'en','CFBundleLocalizations':['en','zh','zh-Hans','zh-Hant'],'NSMicrophoneUsageDescription':'仅在您主动开始时，录制不超过60秒的个人语音样本；核对并确认后才保存到本机样本库。'}
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
for locale in ['en','zh','zh-Hans','zh-Hant']:
 d={'CFBundleDisplayName':"Life's Winner Sample Recorder" if locale=='en' else '人生赢家语音样本录制'}
 if locale=='en':d['NSMicrophoneUsageDescription']='Records a speech sample for up to60 seconds only when you start it. It is saved locally only after you verify and confirm it.'
 f=app/'Contents/Resources'/f'{locale}.lproj'/'InfoPlist.strings';f.parent.mkdir(parents=True,exist_ok=True);f.write_text('\n'.join(json.dumps(k)+' = '+json.dumps(v,ensure_ascii=False)+';' for k,v in d.items())+'\n')
ent=app.parent/'recorder-entitlements.plist';ent.write_bytes(plistlib.dumps({'com.apple.security.device.audio-input':True}))
subprocess.run(['/usr/bin/codesign','--force','--sign',a.identity,'--entitlements',str(ent),str(app)],check=True)
subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
print(json.dumps({'app':str(app),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'microphoneOpened':False}))
