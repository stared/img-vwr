fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_exif <file>");
    let meta = imgvwr_core::read_meta(std::path::Path::new(&path)).expect("read");
    println!("{:#?}", meta.exif);
}
