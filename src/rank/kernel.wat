;; Inkling's similarity kernel (ADR 0010): dot products of one query with many rows, with
;; WebAssembly SIMD. `npm run kernel` compiles this file into kernel-wasm.ts; a unit test checks
;; that the two agree. Float32 rows use the JavaScript implementation (kernel.ts).
(module
  (memory (export "memory") 1)

  ;; int8 rows. The float query comes split into two int16 vectors, q ≈ (hi + lo / s2) / s1,
  ;; and each row's two integer dot products are exact (i32 sums: the caller keeps |hi|, |lo|
  ;; small enough for `dims`). out[i] = (hi · row) · scaleHi + (lo · row) · scaleLo: about 30
  ;; bits of the query, more than float32 arithmetic keeps. dims is a multiple of 16.
  (func (export "dotsI8") (param $qh i32) (param $ql i32) (param $rows i32) (param $n i32) (param $dims i32) (param $out i32) (param $scaleHi f64) (param $scaleLo f64)
    (local $i i32) (local $d i32) (local $p i32) (local $o i32)
    (local $h v128) (local $l v128) (local $b v128) (local $w0 v128) (local $w1 v128)
    (local.set $p (local.get $rows))
    (block $done
      (loop $row
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $h (v128.const i32x4 0 0 0 0))
        (local.set $l (v128.const i32x4 0 0 0 0))
        (local.set $d (i32.const 0))
        (loop $col
          (local.set $b (v128.load (i32.add (local.get $p) (local.get $d))))
          (local.set $w0 (i16x8.extend_low_i8x16_s (local.get $b)))
          (local.set $w1 (i16x8.extend_high_i8x16_s (local.get $b)))
          (local.set $o (i32.shl (local.get $d) (i32.const 1)))
          (local.set $h (i32x4.add (local.get $h) (i32x4.add
            (i32x4.dot_i16x8_s (local.get $w0) (v128.load (i32.add (local.get $qh) (local.get $o))))
            (i32x4.dot_i16x8_s (local.get $w1) (v128.load offset=16 (i32.add (local.get $qh) (local.get $o)))))))
          (local.set $l (i32x4.add (local.get $l) (i32x4.add
            (i32x4.dot_i16x8_s (local.get $w0) (v128.load (i32.add (local.get $ql) (local.get $o))))
            (i32x4.dot_i16x8_s (local.get $w1) (v128.load offset=16 (i32.add (local.get $ql) (local.get $o)))))))
          (local.set $d (i32.add (local.get $d) (i32.const 16)))
          (br_if $col (i32.lt_u (local.get $d) (local.get $dims))))
        (f64.store (i32.add (local.get $out) (i32.shl (local.get $i) (i32.const 3)))
          (f64.add
            (f64.mul (local.get $scaleHi) (f64.convert_i32_s (i32.add
              (i32.add (i32x4.extract_lane 0 (local.get $h)) (i32x4.extract_lane 1 (local.get $h)))
              (i32.add (i32x4.extract_lane 2 (local.get $h)) (i32x4.extract_lane 3 (local.get $h))))))
            (f64.mul (local.get $scaleLo) (f64.convert_i32_s (i32.add
              (i32.add (i32x4.extract_lane 0 (local.get $l)) (i32x4.extract_lane 1 (local.get $l)))
              (i32.add (i32x4.extract_lane 2 (local.get $l)) (i32x4.extract_lane 3 (local.get $l))))))))
        (local.set $p (i32.add (local.get $p) (local.get $dims)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $row))))
)
