#!/usr/bin/env python3
"""Build/sign only the new WorkMailHelper. Does not run or install it."""
import argparse,hashlib,json,pathlib,plistlib,subprocess
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--identity',required=True);args=p.parse_args()
root=pathlib.Path(__file__).resolve().parent;out=pathlib.Path(args.output).resolve()
if out.exists():raise SystemExit('Choose a new output directory; refusing to overwrite')
bundle=out/'WorkMailHelper.app';resources=bundle/'Contents/Resources';binary=bundle/'Contents/MacOS/WorkMailHelper';binary.parent.mkdir(parents=True);resources.mkdir(parents=True)
info={'CFBundleIdentifier':'org.inkspace.desktop.work-mail-helper','CFBundleName':'WorkMailHelper','CFBundleDisplayName':"Life's Winner Mail",'CFBundleExecutable':'WorkMailHelper','CFBundlePackageType':'APPL','CFBundleVersion':'130','CFBundleShortVersionString':'1.0','LSUIElement':True,'NSPrincipalClass':'NSApplication','LSMinimumSystemVersion':'14.0','NSUserNotificationAlertStyle':'alert'}
(bundle/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
for locale,name in [('en',"Life's Winner Mail"),('zh-Hans','人生赢家邮箱')]:
 folder=resources/(locale+'.lproj');folder.mkdir();(folder/'InfoPlist.strings').write_text('"CFBundleDisplayName" = '+json.dumps(name,ensure_ascii=False)+';\n')
sources=[root/'main.swift',root/'WorkMailCore.swift',root/'WorkNotifications.swift']
subprocess.run(['/usr/bin/xcrun','--sdk','macosx','swiftc','-swift-version','6','-module-cache-path',str(out/'module-cache'),'-O','-parse-as-library','-target','arm64-apple-macos14.0',*[str(v) for v in sources],'-o',str(binary)],check=True)
subprocess.run(['/usr/bin/codesign','--force','--sign',args.identity,'--identifier',info['CFBundleIdentifier'],str(bundle)],check=True)
subprocess.run(['/usr/bin/codesign','--verify','--strict',str(bundle)],check=True)
(out/'receipt.json').write_text(json.dumps({'bundle':str(bundle),'sourceHashes':{str(v.name):hashlib.sha256(v.read_bytes()).hexdigest() for v in sources},'executableSHA256':hashlib.sha256(binary.read_bytes()).hexdigest(),'identity':args.identity,'run':False,'install':False},indent=2)+'\n')
print(bundle)
