// Must be the first import of the entry point. Node runs file system calls on a small
// thread pool (4 threads by default). A disk scan is thousands of tiny calls that mostly
// wait on the OS, so a bigger pool makes scans several times faster. The pool is created
// lazily on first use, which is why this has to run before anything touches the disk.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = process.platform === "win32" ? "64" : "16";
}
export {};
