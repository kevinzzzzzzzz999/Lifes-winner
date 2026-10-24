#!/usr/bin/env python3
"""Generate InkSpace's explicit Xcode project using only Python's standard library.

Run from any directory: python3 /path/to/iPad/generate_project.py
Use --check for a read-only consistency check. The generator writes only the
project.pbxproj, shared scheme and Info.plist; it never edits or removes Swift code.
New Swift files anywhere under InkSpace/ are included on the next run.
Generated project settings are authoritative; choose your signing Team in Xcode
after generation. No Xcode build or iOS SDK validation is performed by this script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import xml.etree.ElementTree as ET


BASE = Path(__file__).resolve().parent
SOURCE = BASE / "InkSpace"
PROJECT = BASE / "InkSpace.xcodeproj"


def identifier(label: str) -> str:
    return hashlib.sha256(("InkSpace:" + label).encode("utf-8")).hexdigest()[:24].upper()


def openstep(value, level: int = 0) -> str:
    """Serialize the plist-compatible subset used by explicit .pbxproj objects."""
    indent = "\t" * level
    nested = "\t" * (level + 1)
    if isinstance(value, dict):
        rows = [f"{nested}{json.dumps(str(k))} = {openstep(v, level + 1)};" for k, v in value.items()]
        return "{\n" + "\n".join(rows) + "\n" + indent + "}"
    if isinstance(value, list):
        rows = [nested + openstep(v, level + 1) + "," for v in value]
        return "(\n" + "\n".join(rows) + "\n" + indent + ")"
    if isinstance(value, int):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def make_project(swift_files: list[Path]) -> tuple[bytes, dict]:
    objects = {}

    def add(label: str, isa: str, **fields) -> str:
        object_id = identifier(label)
        if object_id in objects:
            raise ValueError(f"Duplicate project identity: {label}")
        objects[object_id] = {"isa": isa, **fields}
        return object_id

    source_refs = []
    source_builds = []
    for source in swift_files:
        relative = source.relative_to(SOURCE).as_posix()
        file_ref = add("source-ref:" + relative, "PBXFileReference",
                       lastKnownFileType="sourcecode.swift", path=relative, sourceTree="<group>")
        source_refs.append(file_ref)
        source_builds.append(add("source-build:" + relative, "PBXBuildFile", fileRef=file_ref))

    info_ref = add("info-ref", "PBXFileReference", lastKnownFileType="text.plist.xml",
                   path="Info.plist", sourceTree="<group>")
    math_ref = add("math-ref", "PBXFileReference", lastKnownFileType="folder",
                   name="Math", path="Resources/Math", sourceTree="<group>")
    math_build = add("math-build", "PBXBuildFile", fileRef=math_ref)
    mathlab_ref = add("mathlab-ref", "PBXFileReference", lastKnownFileType="folder", name="MathLab", path="Resources/MathLab", sourceTree="<group>")
    mathlab_build = add("mathlab-build", "PBXBuildFile", fileRef=mathlab_ref)
    markdown_ref = add("markdown-ref", "PBXFileReference", lastKnownFileType="folder",
                       name="Markdown", path="Resources/Markdown", sourceTree="<group>")
    markdown_build = add("markdown-build", "PBXBuildFile", fileRef=markdown_ref)
    excel_ref = add("excel-ref", "PBXFileReference", lastKnownFileType="folder",
                    name="Excel", path="Resources/Excel", sourceTree="<group>")
    excel_build = add("excel-build", "PBXBuildFile", fileRef=excel_ref)
    checklist_ref = add("checklist-ref", "PBXFileReference", lastKnownFileType="folder", name="CourseChecklist", path="Resources/CourseChecklist", sourceTree="<group>")
    checklist_build = add("checklist-build", "PBXBuildFile", fileRef=checklist_ref)
    localization_refs, localization_builds = [], []
    for language in ["en", "zh-Hans"]:
        # Folder references preserve the .lproj directory at the bundle root.
        ref = add("localization-ref:" + language, "PBXFileReference",
                  lastKnownFileType="folder", path=language + ".lproj", sourceTree="<group>")
        localization_refs.append(ref)
        localization_builds.append(add("localization-build:" + language, "PBXBuildFile", fileRef=ref))
    assets_ref = add("assets-ref", "PBXFileReference", lastKnownFileType="folder.assetcatalog",
                     path="Assets.xcassets", sourceTree="<group>")
    assets_build = add("assets-build", "PBXBuildFile", fileRef=assets_ref)
    product_ref = add("product-ref", "PBXFileReference", explicitFileType="wrapper.application",
                      includeInIndex=0, path="InkSpace.app", sourceTree="BUILT_PRODUCTS_DIR")

    # Observation is a Swift runtime library on iOS, not an SDK framework.
    # Its Swift import supplies the correct autolink entry.
    frameworks = ["AVFoundation", "MediaPlayer", "CoreGraphics", "CryptoKit", "Foundation", "ImageIO", "PDFKit",
                  "PencilKit", "QuickLook", "QuickLookThumbnailing", "Security", "SwiftUI",
                  "UIKit", "UniformTypeIdentifiers", "VisionKit", "WebKit"]
    framework_refs, framework_builds = [], []
    for name in frameworks:
        ref = add("framework-ref:" + name, "PBXFileReference",
                  lastKnownFileType="wrapper.framework", name=name + ".framework",
                  path=f"System/Library/Frameworks/{name}.framework", sourceTree="SDKROOT")
        framework_refs.append(ref)
        framework_builds.append(add("framework-build:" + name, "PBXBuildFile", fileRef=ref))

    app_group = add("app-group", "PBXGroup", children=source_refs + [info_ref, math_ref, mathlab_ref, markdown_ref, excel_ref, checklist_ref, assets_ref] + localization_refs,
                    path="InkSpace", sourceTree="<group>")
    products_group = add("products-group", "PBXGroup", children=[product_ref],
                         name="Products", sourceTree="<group>")
    frameworks_group = add("frameworks-group", "PBXGroup", children=framework_refs,
                           name="Frameworks", sourceTree="<group>")
    main_group = add("main-group", "PBXGroup", children=[app_group, frameworks_group, products_group],
                     sourceTree="<group>")

    sources_phase = add("sources-phase", "PBXSourcesBuildPhase", buildActionMask=2147483647,
                        files=source_builds, runOnlyForDeploymentPostprocessing=0)
    frameworks_phase = add("frameworks-phase", "PBXFrameworksBuildPhase", buildActionMask=2147483647,
                           files=framework_builds, runOnlyForDeploymentPostprocessing=0)
    resources_phase = add("resources-phase", "PBXResourcesBuildPhase", buildActionMask=2147483647,
                          files=[math_build, mathlab_build, markdown_build, excel_build, checklist_build, assets_build] + localization_builds, runOnlyForDeploymentPostprocessing=0)

    project_base = {
        "ALWAYS_SEARCH_USER_PATHS": "NO",
        "CLANG_ENABLE_MODULES": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES",
        "COPY_PHASE_STRIP": "NO",
        "ENABLE_STRICT_OBJC_MSGSEND": "YES",
        "GCC_C_LANGUAGE_STANDARD": "gnu17",
        "GCC_NO_COMMON_BLOCKS": "YES",
        "IPHONEOS_DEPLOYMENT_TARGET": "18.0",
        "SDKROOT": "iphoneos",
        "SWIFT_VERSION": "5.0",
    }
    target_base = {
        "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        "CODE_SIGN_STYLE": "Automatic",
        "CURRENT_PROJECT_VERSION": "65",
        "DEVELOPMENT_TEAM": "",
        "ENABLE_PREVIEWS": "YES",
        "GENERATE_INFOPLIST_FILE": "NO",
        "INFOPLIST_FILE": "InkSpace/Info.plist",
        "IPHONEOS_DEPLOYMENT_TARGET": "18.0",
        "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/Frameworks"],
        "MARKETING_VERSION": "0.8.5",
        "PRODUCT_BUNDLE_IDENTIFIER": "org.inkspace.app",
        "PRODUCT_NAME": "$(TARGET_NAME)",
        "SDKROOT": "iphoneos",
        "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
        "SUPPORTS_MACCATALYST": "NO",
        "SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD": "NO",
        "SUPPORTS_XR_DESIGNED_FOR_IPHONE_IPAD": "NO",
        "SWIFT_EMIT_LOC_STRINGS": "YES",
        "SWIFT_VERSION": "5.0",
        "TARGETED_DEVICE_FAMILY": "1,2",
    }
    project_configs, target_configs = [], []
    for name in ["Debug", "Release"]:
        debug = name == "Debug"
        settings = dict(project_base)
        settings.update({
            "DEBUG_INFORMATION_FORMAT": "dwarf" if debug else "dwarf-with-dsym",
            "ENABLE_TESTABILITY": "YES" if debug else "NO",
            "GCC_OPTIMIZATION_LEVEL": "0" if debug else "s",
            "ONLY_ACTIVE_ARCH": "YES" if debug else "NO",
            "SWIFT_COMPILATION_MODE": "singlefile" if debug else "wholemodule",
            "SWIFT_OPTIMIZATION_LEVEL": "-Onone" if debug else "-O",
        })
        if debug:
            settings["GCC_PREPROCESSOR_DEFINITIONS"] = ["DEBUG=1", "$(inherited)"]
            settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG $(inherited)"
        project_configs.append(add("project-config:" + name, "XCBuildConfiguration", buildSettings=settings, name=name))
        target_configs.append(add("target-config:" + name, "XCBuildConfiguration", buildSettings=dict(target_base), name=name))

    project_list = add("project-config-list", "XCConfigurationList", buildConfigurations=project_configs,
                       defaultConfigurationIsVisible=0, defaultConfigurationName="Release")
    target_list = add("target-config-list", "XCConfigurationList", buildConfigurations=target_configs,
                      defaultConfigurationIsVisible=0, defaultConfigurationName="Release")
    target = add("app-target", "PBXNativeTarget", buildConfigurationList=target_list,
                 buildPhases=[sources_phase, frameworks_phase, resources_phase], buildRules=[], dependencies=[],
                 name="InkSpace", productName="InkSpace", productReference=product_ref,
                 productType="com.apple.product-type.application")
    project = add("project", "PBXProject", attributes={
        "BuildIndependentTargetsInParallel": "YES", "LastSwiftUpdateCheck": "2600",
        "LastUpgradeCheck": "2600", "TargetAttributes": {
            target: {"CreatedOnToolsVersion": "26.0", "ProvisioningStyle": "Automatic"}
        }
    }, buildConfigurationList=project_list, compatibilityVersion="Xcode 14.0",
        developmentRegion="en", hasScannedForEncodings=0, knownRegions=["en", "zh-Hans", "Base"],
        mainGroup=main_group, productRefGroup=products_group, projectDirPath="", projectRoot="", targets=[target])

    data = {"archiveVersion": 1, "classes": {}, "objectVersion": 56, "objects": objects, "rootObject": project}
    validate_project(data, swift_files)
    # This standalone Xcode project builds the main application.
    return ("// !$*UTF8*$!\n" + openstep(data) + "\n").encode("utf-8"), data


def validate_project(data: dict, swift_files: list[Path]) -> None:
    objects = data["objects"]
    refs = [v for v in objects.values() if v["isa"] == "PBXFileReference"]
    source_paths = [SOURCE / ref["path"] for ref in refs if ref.get("lastKnownFileType") == "sourcecode.swift"]
    if set(source_paths) != set(swift_files) or not all(path.is_file() for path in source_paths):
        raise ValueError("Swift source references do not match existing source files")
    math = SOURCE / "Resources/Math"
    for path in [math / "index.html", math / "renderer.js", math / "katex.min.js", math / "katex.min.css", math / "fonts"]:
        if not path.exists():
            raise FileNotFoundError(path)
    markdown = SOURCE / "Resources/Markdown"
    for name in ["index.html", "reader.js", "reader.css", "marked.umd.js", "MARKED-LICENSE.md"]:
        if not (markdown / name).is_file():
            raise FileNotFoundError(markdown / name)
    build_refs = {v["fileRef"] for v in objects.values() if v["isa"] == "PBXBuildFile"}
    excel = SOURCE / "Resources/Excel"
    for name in ["index.html", "reader.js", "xlsx.full.min.js", "LICENSE-SheetJS.txt", "PROVENANCE.json"]:
        if not (excel / name).is_file():
            raise FileNotFoundError(excel / name)
    if not build_refs.issubset(objects):
        raise ValueError("Build phase contains a missing file reference")
    if identifier("info-ref") in build_refs:
        raise ValueError("Info.plist must not be copied by a build phase")
    resources = objects[identifier("resources-phase")]["files"]
    if resources != [identifier("math-build"), identifier("mathlab-build"), identifier("markdown-build"), identifier("excel-build"), identifier("checklist-build"), identifier("assets-build"), identifier("localization-build:en"), identifier("localization-build:zh-Hans")]:
        raise ValueError("Math, Markdown, Excel, CourseChecklist, Assets and both localizations must all be included as resources")
    for language in ["en", "zh-Hans"]:
        for name in ["Localizable.strings", "InfoPlist.strings"]:
            if not (SOURCE / (language + ".lproj") / name).is_file():
                raise FileNotFoundError(SOURCE / (language + ".lproj") / name)
    assets = SOURCE / "Assets.xcassets"
    for path in [assets / "Contents.json", assets / "AppIcon.appiconset/Contents.json",
                 assets / "AppIcon.appiconset/AppIcon.png"]:
        if not path.is_file():
            raise FileNotFoundError(path)


def make_info() -> bytes:
    orientations = ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
                    "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"]
    info = {
        "CFBundleDevelopmentRegion": "$(DEVELOPMENT_LANGUAGE)",
        "CFBundleDisplayName": "人生赢家",
        "CFBundleLocalizations": ["en", "zh-Hans"],
        "CFBundleExecutable": "$(EXECUTABLE_NAME)",
        "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "人生赢家",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "NSCameraUsageDescription": "扫描纸质资料并保存为 PDF。Scan paper documents and save them as PDF.",
        "NSMicrophoneUsageDescription": "允许你在 AI 网页和内置网页中使用麦克风进行语音输入或对话。Allow microphone access for voice input and conversations in AI and embedded webpages.",
        "CFBundleURLTypes": [{
            "CFBundleTypeRole": "Editor", "CFBundleURLName": "org.inkspace.app",
            "CFBundleURLSchemes": ["inkspace"],
        }],
        "LSRequiresIPhoneOS": True,
        "LSSupportsOpeningDocumentsInPlace": True,
        "UIFileSharingEnabled": True,
        "UIBackgroundModes": ["fetch", "audio"],
        "BGTaskSchedulerPermittedIdentifiers": ["org.inkspace.app.board-refresh"],
        "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": True},
        "UILaunchScreen": {},
        "UISupportedInterfaceOrientations": orientations,
        "UISupportedInterfaceOrientations~ipad": orientations,
    }
    # Only system-scheduled app refresh; no audio/location keep-alive or ATS exemption.
    return plistlib.dumps(info, fmt=plistlib.FMT_XML, sort_keys=False)


def make_scheme() -> bytes:
    def buildable(parent):
        return ET.SubElement(parent, "BuildableReference", {
            "BuildableIdentifier": "primary", "BlueprintIdentifier": identifier("app-target"),
            "BuildableName": "InkSpace.app", "BlueprintName": "InkSpace",
            "ReferencedContainer": "container:InkSpace.xcodeproj",
        })

    root = ET.Element("Scheme", {"LastUpgradeVersion": "2600", "version": "1.7"})
    build = ET.SubElement(root, "BuildAction", {"parallelizeBuildables": "YES", "buildImplicitDependencies": "YES"})
    entries = ET.SubElement(build, "BuildActionEntries")
    entry = ET.SubElement(entries, "BuildActionEntry", {
        "buildForTesting": "YES", "buildForRunning": "YES", "buildForProfiling": "YES",
        "buildForArchiving": "YES", "buildForAnalyzing": "YES",
    })
    buildable(entry)
    test = ET.SubElement(root, "TestAction", {
        "buildConfiguration": "Debug", "selectedDebuggerIdentifier": "Xcode.DebuggerFoundation.Debugger.LLDB",
        "selectedLauncherIdentifier": "Xcode.IDEFoundation.Launcher.LLDB", "shouldUseLaunchSchemeArgsEnv": "YES",
    })
    ET.SubElement(test, "Testables")
    launch = ET.SubElement(root, "LaunchAction", {
        "buildConfiguration": "Debug", "selectedDebuggerIdentifier": "Xcode.DebuggerFoundation.Debugger.LLDB",
        "selectedLauncherIdentifier": "Xcode.IDEFoundation.Launcher.LLDB", "launchStyle": "0",
        "useCustomWorkingDirectory": "NO", "ignoresPersistentStateOnLaunch": "NO",
        "debugDocumentVersioning": "YES", "debugServiceExtension": "internal", "allowLocationSimulation": "YES",
    })
    buildable(ET.SubElement(launch, "BuildableProductRunnable", {"runnableDebuggingMode": "0"}))
    profile = ET.SubElement(root, "ProfileAction", {
        "buildConfiguration": "Release", "shouldUseLaunchSchemeArgsEnv": "YES", "savedToolIdentifier": "",
        "useCustomWorkingDirectory": "NO", "debugDocumentVersioning": "YES",
    })
    buildable(ET.SubElement(profile, "BuildableProductRunnable", {"runnableDebuggingMode": "0"}))
    ET.SubElement(root, "AnalyzeAction", {"buildConfiguration": "Debug"})
    ET.SubElement(root, "ArchiveAction", {"buildConfiguration": "Release", "revealArchiveInOrganizer": "YES"})
    ET.indent(root, space="   ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) + b"\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check existing generated files without writing")
    args = parser.parse_args()
    swift_files = sorted(SOURCE.rglob("*.swift"))
    if not swift_files:
        raise SystemExit("No Swift sources found under InkSpace/")
    project_bytes, _ = make_project(swift_files)
    generated = {
        PROJECT / "project.pbxproj": project_bytes,
        SOURCE / "Info.plist": make_info(),
        PROJECT / "xcshareddata/xcschemes/InkSpace.xcscheme": make_scheme(),
    }
    for path, data in generated.items():
        if args.check:
            if not path.is_file() or path.read_bytes() != data:
                raise SystemExit(f"Generated file is missing or differs: {path}; rerun this script without --check")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    plistlib.loads((SOURCE / "Info.plist").read_bytes())
    ET.parse(PROJECT / "xcshareddata/xcschemes/InkSpace.xcscheme")
    plutil = shutil.which("plutil")
    if plutil:
        subprocess.run([plutil, "-lint", str(PROJECT / "project.pbxproj"), str(SOURCE / "Info.plist")], check=True)
    print(f"{'Checked' if args.check else 'Generated'}: {len(swift_files)} existing Swift sources; Math folder resources present.")
    print("iPhone + iPad · iOS 18.0 · Swift 5.0 · automatic signing (choose a Team in Xcode).")
    print("Configuration validation only; no iOS build or device test has been performed.")


if __name__ == "__main__":
    main()
