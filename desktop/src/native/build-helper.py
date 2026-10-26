#!/usr/bin/env python3
"""Compile the windowless macOS PencilKit helper. Does not launch or install it."""
import argparse,pathlib,plistlib,subprocess,hashlib,json,platform
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path);p.add_argument('--arch',choices=['arm64','x86_64'],default=platform.machine());args=p.parse_args()
src=pathlib.Path(__file__).resolve().parent;desktop=src.parent.parent
out=args.output or desktop/'runtime/native-ink'/('darwin-'+args.arch)/'InkSpaceInkHelper.app'
exe=out/'Contents/MacOS/InkSpaceInkHelper';exe.parent.mkdir(parents=True,exist_ok=True)
sdk=subprocess.check_output(['xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
subprocess.run(['xcrun','swiftc','-swift-version','5','-O','-target',args.arch+'-apple-macos13.0','-sdk',sdk,'-module-cache-path',str(desktop.parent/'work/native-ink/build-cache'),str(src/'NativeInkCore.swift'),str(src/'InkSpaceInkHelper.swift'),'-o',str(exe)],check=True)
info={'CFBundleIdentifier':'org.inkspace.native-ink-helper','CFBundleExecutable':'InkSpaceInkHelper','CFBundleName':'InkSpace Ink Helper','CFBundleDisplayName':"Life's Winner Ink Helper",'CFBundleVersion':'1','CFBundlePackageType':'APPL','LSUIElement':True,'LSMinimumSystemVersion':'13.0'}
info.update({'CFBundleDevelopmentRegion':'en','CFBundleLocalizations':['en','zh','zh-Hans','zh-Hant']})
(out/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
for brand_locale in ['en','zh','zh-Hans','zh-Hant']:
 brand_name="Life's Winner Ink Helper" if brand_locale=='en' else '人生赢家手写组件'
 brand_fields={'CFBundleDisplayName':brand_name}
 brand_file=out/'Contents/Resources'/f'{brand_locale}.lproj'/'InfoPlist.strings'
 brand_file.parent.mkdir(parents=True,exist_ok=True)
 brand_file.write_text('\n'.join(json.dumps(key)+' = '+json.dumps(value,ensure_ascii=False)+';' for key,value in brand_fields.items())+'\n',encoding='utf-8')

print(json.dumps({'executable':str(exe),'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'architecture':args.arch,'minimumMacOS':'13.0','launched':False}))
