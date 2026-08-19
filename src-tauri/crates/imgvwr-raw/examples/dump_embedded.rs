fn main() {
    let mut args = std::env::args().skip(1);
    let (input, output) = (args.next().expect("IN.NEF"), args.next().expect("OUT.jpg"));
    let bytes = imgvwr_raw::embedded_jpeg(std::path::Path::new(&input))
        .expect("no embedded JPEG found");
    std::fs::write(&output, &bytes).expect("write failed");
    println!("{} bytes -> {}", bytes.len(), output);
}
