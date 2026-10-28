fn main() {
    println!("cargo:rerun-if-changed=windows/common-controls.rc");
    println!("cargo:rerun-if-changed=windows/common-controls.manifest");

    // Keep Tauri icon and version resources, and link one manifest to every target.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to build Tauri resources");

    embed_resource::compile_for_everything("windows/common-controls.rc", embed_resource::NONE)
        .manifest_required()
        .expect("failed to embed the Windows common-controls manifest");
}
