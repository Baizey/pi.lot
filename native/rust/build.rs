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
    println!("cargo:rerun-if-env-changed=CC");
    println!("cargo:rerun-if-env-changed=AR");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_LIBDIR");
    println!("cargo:rerun-if-changed=../pi-fuse-shim.c");

    let fuse_flags = sdk_flags("fuse3");
    let queue_flags = sdk_flags("libnetfilter_queue");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = output.join("pi-fuse-shim.o");
    let archive = output.join("libpilot_fuse_shim.a");
    run(
        Command::new(env::var_os("CC").unwrap_or_else(|| "cc".into()))
            .args([
                "-std=c17",
                "-O2",
                "-g",
                "-fPIC",
                "-Wall",
                "-Wextra",
                "-Wpedantic",
                "-c",
            ])
            .arg("../pi-fuse-shim.c")
            .arg("-o")
            .arg(&object)
            .args(&fuse_flags),
    );
    run(
        Command::new(env::var_os("AR").unwrap_or_else(|| "ar".into()))
            .arg("crs")
            .arg(&archive)
            .arg(&object),
    );
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=pilot_fuse_shim");
    emit_link_flags(&fuse_flags);
    emit_link_flags(&queue_flags);
}

fn sdk_flags(package: &str) -> Vec<String> {
    if let Some(directory) = env::var_os("PILOT_NATIVE_SDK_FLAGS") {
        // npm's resolver already validates the SDK and decodes shell quoting.
        // NUL-separated files preserve each argument exactly, including spaces.
        let path = Path::new(&directory).join(format!("{package}.flags"));
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = fs::read(&path).expect("read validated SDK flags");
        return bytes
            .strip_suffix(&[0])
            .expect("SDK flags require a NUL terminator")
            .split(|&byte| byte == 0)
            .map(|part| String::from_utf8(part.to_vec()).expect("UTF-8 SDK flag"))
            .collect();
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

fn emit_link_flags(flags: &[String]) {
    let mut arguments = flags.iter();
    while let Some(flag) = arguments.next() {
        if flag == "-L" {
            println!(
                "cargo:rustc-link-search=native={}",
                arguments.next().expect("path after -L")
            );
        } else if let Some(path) = flag.strip_prefix("-L") {
            println!("cargo:rustc-link-search=native={path}");
        } else if flag == "-l" {
            println!(
                "cargo:rustc-link-lib={}",
                arguments.next().expect("library after -l")
            );
        } else if let Some(library) = flag.strip_prefix("-l") {
            println!("cargo:rustc-link-lib={library}");
        } else if flag == "-pthread" {
            println!("cargo:rustc-link-lib=pthread");
        } else if flag.starts_with("-Wl,") || flag.ends_with(".so") || flag.ends_with(".a") {
            println!("cargo:rustc-link-arg={flag}");
        }
    }
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
