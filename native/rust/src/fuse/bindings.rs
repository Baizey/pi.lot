//! System libfuse ABI generated from the SDK selected by the native builder.
#![allow(
    dead_code,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_imports
)]
// Bindgen's bitfield helpers use patterns that clippy warns about in hand-written
// code. Keep that allowance scoped to generated declarations only.
#![allow(clippy::all, clippy::pedantic)]

include!(concat!(env!("OUT_DIR"), "/fuse_bindings.rs"));
