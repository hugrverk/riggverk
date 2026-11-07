fn main() {
    if is_windows_msvc() {
        windows_build();
    } else {
        tauri_build::build();
    }
}

fn is_windows_msvc() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}

/// `tauri_build` embeds the app manifest in the app binary only. Any other executable that links
/// the Tauri runtime, the unit-test executable of the library included, then loads comctl32 v5
/// and dies at startup with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) before running a test.
///
/// So the manifest is embedded in every executable from one file, and `tauri_build` is told not
/// to add its own: the linker rejects two (CVT1100). `windows-app.manifest` declares the same
/// single dependency as `tauri_build`'s default manifest (Common-Controls 6.0), so the app's
/// manifest does not change in meaning.
fn windows_build() {
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }

    let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("windows-app.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
