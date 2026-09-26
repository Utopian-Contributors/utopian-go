/**
 * libuv's worker pool, sized before anything uses it.
 *
 * Password hashing (scrypt), logo resizing (sharp), file reads, zlib and DNS
 * lookups all queue on this one pool, and Node's default is four threads. A
 * burst of logins would then hold up every static file and every upstream
 * DNS lookup behind it. The pool is created on first use, so this module is
 * imported first, ahead of anything that could touch it.
 */
process.env.UV_THREADPOOL_SIZE ??= "16";
