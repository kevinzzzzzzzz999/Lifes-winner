# Publication and synchronization

Only reviewed application source and redistributable assets belong in this repository.

1. Select a completed development snapshot and preserve its version identity. Do not copy an entire development folder, notes vault, application container or installed application bundle.
2. Export only the established source directories and build inputs. Exclude credentials, private content, device identifiers, signing profiles, caches and diagnostic evidence. Preserve third-party licenses.
3. Review every new or changed file. Scan file contents, paths, image metadata and commit metadata for private information. A clean automated scan supplements source review; it does not replace it.
4. Run the relevant build and existing regression checks on the exported copy. Describe remaining platform limitations accurately.
5. Commit the exact reviewed copy using the project name and a privacy-preserving commit email. Push to the intended repository without force-pushing or replacing unrelated remote changes.
6. Verify the published commit and update the release notes. If privacy, version identity or validation is uncertain, stop publication and resolve it first.

The development source and private publication state are maintained separately from this public tree. Local synchronization requires the source computer and its automation service to be available. GitHub does not read local source folders by itself.

The initial public release provides source code and build guides. It does not claim App Store distribution, notarization or universal one-click installation.
