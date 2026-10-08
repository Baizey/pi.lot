use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    assert_eq!(
        env::var("CARGO_CFG_TARGET_OS").unwrap(),
        "linux",
        "Pilot requires Linux"
    );
    assert_eq!(
        env::var("CARGO_CFG_TARGET_ARCH").unwrap(),
        "x86_64",
        "Pilot currently requires x86-64"
    );
    println!("cargo:rerun-if-env-changed=PILOT_NATIVE_SDK_FLAGS");
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");
    println!("cargo:rerun-if-env-changed=CLANG_PATH");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_SYSROOT_DIR");

    let fuse_flags = sdk_flags("fuse3");
    let queue_flags = sdk_flags("libnetfilter_queue");
    generate_fuse_bindings(&fuse_flags);
    emit_link_flags(&fuse_flags);
    emit_link_flags(&queue_flags);
}

fn generate_fuse_bindings(flags: &[String]) {
    // libclang is loaded by bindgen, not by a clang executable. Fail before
    // writing bindings (and before the npm builder publishes any helpers).
    let version = std::panic::catch_unwind(bindgen::clang_version).unwrap_or_else(|_| {
        panic!(
            "libclang is required to generate Pilot's system libfuse bindings. \
             Install clang-libs/clang-devel on Fedora or libclang-dev on Ubuntu. \
             If installed in a nonstandard location, set LIBCLANG_PATH to the \
             directory containing libclang.so."
        )
    });
    let library = clang_sys::get_library().expect("bindgen loaded libclang on this thread");
    let resource_dir = clang_resource_dir(library.path(), &version.full);
    let mut clang_args = Vec::new();
    if let Some(directory) = &resource_dir {
        // Defaults precede SDK options and bindgen's extra environment options,
        // so an explicit -resource-dir always wins. No clang executable or
        // unrelated C compiler's include paths are needed for builtin headers.
        clang_args.push("-resource-dir".to_owned());
        clang_args.push(
            directory
                .to_str()
                .expect("UTF-8 clang resource directory")
                .to_owned(),
        );
    }
    clang_args.extend(compiler_flags(flags).into_iter().map(str::to_owned));
    let bindings = bindgen::Builder::default()
        .header_contents(
            "pilot-fuse-bindings.h",
            "#define _GNU_SOURCE\n#define _FILE_OFFSET_BITS 64\n#define FUSE_USE_VERSION 317\n#include <fuse.h>\n",
        )
        .clang_args(clang_args)
        .allowlist_type("fuse_(operations|file_info|context|conn_info|config|fill_dir_t|readdir_flags|fill_dir_flags)")
        .allowlist_type("libfuse_version")
        .allowlist_function("fuse_(get_context|unset_feature_flag|main_real_versioned)")
        .allowlist_var("FUSE_(MAJOR_VERSION|MINOR_VERSION|HOTFIX_VERSION)")
        .allowlist_var("FUSE_CAP_(DIRECT_IO_ALLOW_MMAP|WRITEBACK_CACHE|PASSTHROUGH|ASYNC_DIO|ATOMIC_O_TRUNC|NO_OPEN_SUPPORT|NO_OPENDIR_SUPPORT)")
        // Sharing libc's platform types makes callback signatures type-identical
        // to the Rust backing operations rather than creating competing layouts.
        .blocklist_type("(stat|statvfs|timespec|statx|flock|mode_t|off_t|uid_t|gid_t|dev_t|pid_t|ssize_t|size_t)")
        .raw_line("pub use libc::{stat, statvfs, timespec, statx, flock, mode_t, off_t, uid_t, gid_t, dev_t, pid_t, ssize_t, size_t};")
        .ctypes_prefix("libc")
        .generate_comments(false)
        .derive_default(true)
        .rust_target("1.85".parse().expect("supported bindgen Rust target"))
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .unwrap_or_else(|error| {
            panic!(
                "could not generate system libfuse bindings from fuse.h: {error}. \
                 Loaded libclang {} ({}) with discovered resource directory {:?}. \
                 For missing builtin headers such as stdarg.h, install the matching \
                 Clang resource headers (clang-resource-files/clang-devel on Fedora, \
                 libclang-common-<version>-dev on Ubuntu), or set \
                 BINDGEN_EXTRA_CLANG_ARGS='-resource-dir=/path/to/lib/clang/<version>'. \
                 For missing fuse.h, install libfuse3 development files and check \
                 pkg-config or PILOT_NATIVE_SDK_FLAGS.",
                library.path().display(), version.full, resource_dir
            )
        });
    bindings
        .write_to_file(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("fuse_bindings.rs"))
        .expect("write generated system libfuse bindings");
}

fn clang_resource_dir(library: &Path, version: &str) -> Option<PathBuf> {
    let version = version
        .split_whitespace()
        .find_map(clang_version_components)?;
    let mut libraries = vec![library.to_path_buf()];
    if let Ok(canonical) = fs::canonicalize(library) {
        if canonical != library {
            libraries.push(canonical);
        }
    }
    for library in libraries {
        let directory = library.parent()?;
        let mut roots = vec![directory.join("clang")];
        if let Some(prefix) = directory.parent() {
            // Covers multiarch lib directories as well as lib/lib64 layouts.
            roots.push(prefix.join("clang"));
            roots.push(prefix.join("lib/clang"));
            roots.push(prefix.join("lib64/clang"));
        }
        for root in roots {
            if let Some(resource) = matching_clang_resource(&root, &version) {
                return Some(resource);
            }
        }
    }
    // libclang's compiled-in resource path or explicit caller flags may still
    // work. Let parsing decide, with an actionable diagnostic if it fails.
    None
}

fn clang_version_components(token: &str) -> Option<Vec<u32>> {
    let numeric = token
        .split(|character: char| !character.is_ascii_digit() && character != '.')
        .next()?;
    let numbers: Vec<u32> = numeric
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    (numbers.len() >= 2).then_some(numbers)
}

fn matching_clang_resource(root: &Path, version: &[u32]) -> Option<PathBuf> {
    let full = version
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(".");
    for name in [full, version[0].to_string()] {
        let directory = root.join(name);
        if directory.join("include/stdarg.h").is_file() {
            return Some(directory);
        }
    }
    // Some distributions update resource-header patch versions independently
    // from the library package. Only consider the loaded library's major version.
    let mut candidates: Vec<_> = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let numbers = clang_version_components(entry.file_name().to_str()?)?;
            (numbers[0] == version[0] && entry.path().join("include/stdarg.h").is_file())
                .then_some((numbers, entry.path()))
        })
        .collect();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

fn sdk_flags(package: &str) -> Vec<String> {
    if let Some(directory) = env::var_os("PILOT_NATIVE_SDK_FLAGS") {
        // npm's resolver already validates the SDK and decodes shell quoting.
        // NUL-separated files preserve each argument exactly, including spaces.
        let path = Path::new(&directory).join(format!("{package}.flags"));
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(&path).expect("read validated SDK flags");
        return parse_sdk_flags(&bytes);
    }
    // Direct cargo invocations have the same minimum as the npm build.
    if package == "fuse3" {
        run(Command::new("pkg-config")
            .arg("--atleast-version=3.17.3")
            .arg(package));
    }
    let result = Command::new("pkg-config")
        .args(["--cflags", "--libs", package])
        .output()
        .expect("pkg-config is required to locate native SDKs");
    assert!(
        result.status.success(),
        "missing {package} development files: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let flags = parse_flags(&String::from_utf8(result.stdout).expect("UTF-8 pkg-config output"));
    assert!(
        !flags.is_empty(),
        "pkg-config returned no flags for {package}"
    );
    flags
}

fn parse_sdk_flags(bytes: &[u8]) -> Vec<String> {
    bytes
        .strip_suffix(&[0])
        .expect("SDK flags require a NUL terminator")
        .split(|&byte| byte == 0)
        .map(|part| String::from_utf8(part.to_vec()).expect("UTF-8 SDK flag"))
        .collect()
}

fn compiler_option_takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "-I" | "-isystem"
            | "-iquote"
            | "-idirafter"
            | "-iprefix"
            | "-iwithprefix"
            | "-iwithprefixbefore"
            | "-D"
            | "-U"
            | "-include"
            | "-imacros"
            | "-isysroot"
            | "--sysroot"
            | "-target"
            | "--target"
            | "-x"
            | "-std"
            | "-B"
            | "-resource-dir"
            | "-Xclang"
            | "-Xpreprocessor"
    )
}

fn compiler_flags(flags: &[String]) -> Vec<&str> {
    let mut compiler = Vec::new();
    let mut arguments = flags.iter();
    while let Some(flag) = arguments.next() {
        if compiler_option_takes_value(flag) {
            compiler.push(flag.as_str());
            compiler.push(
                arguments
                    .next()
                    .expect("value after compiler option")
                    .as_str(),
            );
        } else if matches!(flag.as_str(), "-L" | "-l" | "-Xlinker" | "-framework") {
            arguments.next().expect("value after linker option");
        } else if flag.starts_with("-I")
            || flag.starts_with("-D")
            || flag.starts_with("-U")
            || flag.starts_with("-isystem")
            || flag.starts_with("-iquote")
            || flag.starts_with("-idirafter")
            || flag.starts_with("-iprefix")
            || flag.starts_with("-iwithprefix")
            || flag.starts_with("-isysroot")
            || flag.starts_with("-include")
            || flag.starts_with("-imacros")
            || flag.starts_with("-resource-dir=")
            || flag.starts_with("--sysroot=")
            || flag.starts_with("--target=")
            || flag.starts_with("-std=")
            || flag.starts_with("-Wp,")
            || flag.starts_with("-m")
            || (flag.starts_with("-f") && !flag.starts_with("-fuse-ld="))
            || matches!(
                flag.as_str(),
                "-pthread" | "-nostdinc" | "-nostdinc++" | "-ansi"
            )
        {
            compiler.push(flag.as_str());
        }
    }
    compiler
}

fn emit_link_flags(flags: &[String]) {
    for directive in link_directives(flags) {
        println!("{directive}");
    }
}

fn link_directives(flags: &[String]) -> Vec<String> {
    let mut directives = Vec::new();
    let mut arguments = flags.iter();
    while let Some(flag) = arguments.next() {
        if compiler_option_takes_value(flag) {
            arguments.next().expect("value after compiler option");
        } else if flag == "-Xlinker" {
            directives.push(format!(
                "cargo:rustc-link-arg={}",
                arguments.next().expect("value after -Xlinker")
            ));
        } else if flag == "-L" {
            directives.push(format!(
                "cargo:rustc-link-search=native={}",
                arguments.next().expect("path after -L")
            ));
        } else if let Some(path) = flag.strip_prefix("-L") {
            directives.push(format!("cargo:rustc-link-search=native={path}"));
        } else if flag == "-l" {
            directives.push(format!(
                "cargo:rustc-link-lib={}",
                arguments.next().expect("library after -l")
            ));
        } else if let Some(library) = flag.strip_prefix("-l") {
            directives.push(format!("cargo:rustc-link-lib={library}"));
        } else if flag == "-pthread" {
            directives.push("cargo:rustc-link-lib=pthread".into());
        } else if flag.starts_with("-Wl,")
            || (!flag.starts_with('-') && (flag.ends_with(".so") || flag.ends_with(".a")))
        {
            directives.push(format!("cargo:rustc-link-arg={flag}"));
        }
    }
    directives
}

fn run(command: &mut Command) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("{command:?}: {error}"));
    assert!(status.success(), "native build command failed: {command:?}");
}

fn parse_flags(input: &str) -> Vec<String> {
    let mut flags = Vec::new();
    let mut argument = String::new();
    let mut quote = None;
    let mut started = false;
    let mut characters = input.chars();
    while let Some(character) = characters.next() {
        if character == '\\' && quote != Some('\'') {
            let next = characters
                .next()
                .expect("malformed pkg-config flags: trailing escape");
            if quote == Some('"') && !['"', '\\', '$', '`', '\n'].contains(&next) {
                argument.push('\\');
            }
            if next != '\n' {
                argument.push(next);
            }
            started = true;
        } else if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                argument.push(character);
            }
        } else if character == '\'' || character == '"' {
            quote = Some(character);
            started = true;
        } else if character.is_whitespace() {
            if started {
                flags.push(std::mem::take(&mut argument));
            }
            started = false;
        } else {
            argument.push(character);
            started = true;
        }
    }
    assert!(
        quote.is_none(),
        "malformed pkg-config flags: unterminated quote"
    );
    if started {
        flags.push(argument);
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct ResourceFixture(PathBuf);

    impl ResourceFixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = env::temp_dir().join(format!(
                "pilot-clang-resources-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn header(&self, relative: &str) -> PathBuf {
            let directory = self.0.join(relative);
            fs::create_dir_all(directory.join("include")).unwrap();
            fs::write(directory.join("include/stdarg.h"), "").unwrap();
            directory
        }
    }

    impl Drop for ResourceFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn resource_discovery_uses_loaded_library_version_and_adjacent_headers() {
        let fixture = ResourceFixture::new();
        let expected = fixture.header("llvm/lib/clang/15.0.7");
        fixture.header("llvm/lib/clang/16.0.0");
        assert_eq!(
            clang_resource_dir(
                &fixture.0.join("llvm/lib/libclang.so.15"),
                "clang version 15.0.7"
            ),
            Some(expected)
        );
    }

    #[test]
    fn resource_discovery_supports_major_only_and_multiarch_layouts() {
        let fixture = ResourceFixture::new();
        let expected = fixture.header("lib/clang/19");
        assert_eq!(
            clang_resource_dir(
                &fixture.0.join("lib/x86_64-linux-gnu/libclang.so.19"),
                "Debian clang version 19.1.7-3"
            ),
            Some(expected)
        );
    }

    #[test]
    fn resource_versions_accept_distribution_suffixes_not_unrelated_tokens() {
        assert_eq!(
            clang_version_components("19.1.7-3ubuntu1"),
            Some(vec![19, 1, 7])
        );
        assert_eq!(clang_version_components("Fedora"), None);
        assert_eq!(clang_version_components("https://llvm.org"), None);
    }

    #[test]
    fn resources_prefer_exact_then_major_then_matching_patch_version() {
        let fixture = ResourceFixture::new();
        let root = fixture.0.join("clang");
        let patch = fixture.header("clang/15.0.9");
        fixture.header("clang/15.0.8");
        fixture.header("clang/16.0.0");
        assert_eq!(matching_clang_resource(&root, &[15, 0, 7]), Some(patch));
        let major = fixture.header("clang/15");
        assert_eq!(matching_clang_resource(&root, &[15, 0, 7]), Some(major));
        let exact = fixture.header("clang/15.0.7");
        assert_eq!(matching_clang_resource(&root, &[15, 0, 7]), Some(exact));
    }

    #[test]
    fn resources_reject_other_versions_and_missing_builtin_headers() {
        let fixture = ResourceFixture::new();
        fixture.header("clang/16.0.0");
        fs::create_dir_all(fixture.0.join("clang/15.0.7/include")).unwrap();
        assert_eq!(
            matching_clang_resource(&fixture.0.join("clang"), &[15, 0, 7]),
            None
        );
        assert_eq!(
            clang_resource_dir(&fixture.0.join("libclang.so"), "unknown version"),
            None
        );
    }

    #[test]
    fn quoted_pkg_config_arguments_remain_literal() {
        assert_eq!(
            parse_flags(
                r#"-I'/sdk directory/include' -L/sdk\ directory/lib -DNAME='$(literal)' "" '' -lfuse3"#
            ),
            [
                "-I/sdk directory/include",
                "-L/sdk directory/lib",
                "-DNAME=$(literal)",
                "",
                "",
                "-lfuse3"
            ]
        );
    }

    #[test]
    fn shell_double_quote_backslashes_are_preserved() {
        assert_eq!(
            parse_flags(r#""one\q two\\three" 'four\five'"#),
            [r"one\q two\three", r"four\five"]
        );
    }

    #[test]
    fn sdk_nul_arguments_preserve_empty_flags_and_spaces() {
        assert_eq!(
            parse_sdk_flags(b"-I/sdk directory/include\0\0-lfuse3\0\0"),
            ["-I/sdk directory/include", "", "-lfuse3", ""]
        );
        assert_eq!(parse_sdk_flags(b"\0"), [""]);
    }

    #[test]
    fn clang_receives_compiler_options_but_not_linker_arguments() {
        let flags = [
            "-I",
            "/sdk directory/include",
            "-isystem",
            "/system include",
            "-D",
            "NAME=literal value",
            "-U",
            "OLD_NAME",
            "-include",
            "header.a",
            "-imacros",
            "macros.h",
            "--sysroot",
            "/sdk root",
            "-Xpreprocessor",
            "-DOTHER",
            "-Ijoined",
            "-isystemjoined",
            "-DNEW=1",
            "-UOLD",
            "-std=c17",
            "-resource-dir=/explicit resource",
            "-resource-dir",
            "/paired resource",
            "-pthread",
            "-L",
            "/sdk library",
            "-l",
            "fuse3",
            "-Ljoined",
            "-lfuse3",
            "-Wl,-rpath,/sdk library",
            "-Xlinker",
            "--as-needed",
            "-fuse-ld=lld",
            "/sdk/libextra.so",
            "",
            "-nostdinc",
        ]
        .map(String::from);
        assert_eq!(
            compiler_flags(&flags),
            [
                "-I",
                "/sdk directory/include",
                "-isystem",
                "/system include",
                "-D",
                "NAME=literal value",
                "-U",
                "OLD_NAME",
                "-include",
                "header.a",
                "-imacros",
                "macros.h",
                "--sysroot",
                "/sdk root",
                "-Xpreprocessor",
                "-DOTHER",
                "-Ijoined",
                "-isystemjoined",
                "-DNEW=1",
                "-UOLD",
                "-std=c17",
                "-resource-dir=/explicit resource",
                "-resource-dir",
                "/paired resource",
                "-pthread",
                "-nostdinc",
            ]
        );
    }

    #[test]
    fn linking_preserves_sdk_order_and_ignores_compiler_option_values() {
        let flags = [
            "-include",
            "/sdk/header.a",
            "-isystem",
            "/sdk/header.so",
            "-D",
            "NAME=lib.a",
            "-L",
            "/sdk library",
            "-l",
            "fuse3",
            "-Ljoined",
            "-lextra",
            "-pthread",
            "-Wl,-rpath,/sdk library",
            "-Xlinker",
            "--as-needed",
            "/sdk/libextra.so",
            "/sdk/libstatic.a",
            "",
        ]
        .map(String::from);
        assert_eq!(
            link_directives(&flags),
            [
                "cargo:rustc-link-search=native=/sdk library",
                "cargo:rustc-link-lib=fuse3",
                "cargo:rustc-link-search=native=joined",
                "cargo:rustc-link-lib=extra",
                "cargo:rustc-link-lib=pthread",
                "cargo:rustc-link-arg=-Wl,-rpath,/sdk library",
                "cargo:rustc-link-arg=--as-needed",
                "cargo:rustc-link-arg=/sdk/libextra.so",
                "cargo:rustc-link-arg=/sdk/libstatic.a",
            ]
        );
    }

    #[test]
    #[should_panic(expected = "value after compiler option")]
    fn compiler_options_require_their_paired_value() {
        compiler_flags(&["-isystem".into()]);
    }

    #[test]
    #[should_panic(expected = "value after linker option")]
    fn linker_options_require_their_paired_value() {
        compiler_flags(&["-L".into()]);
    }

    #[test]
    #[should_panic(expected = "NUL terminator")]
    fn sdk_arguments_require_a_terminator() {
        parse_sdk_flags(b"-lfuse3");
    }

    #[test]
    #[should_panic(expected = "unterminated quote")]
    fn pkg_config_rejects_unterminated_quotes() {
        parse_flags("-I'unterminated");
    }

    #[test]
    #[should_panic(expected = "trailing escape")]
    fn pkg_config_rejects_trailing_escape() {
        parse_flags("-Itrailing\\");
    }
}
