---
id: coalesced-warp-mapping-memory-bound
title: "A transposed warp mapping costs ~10x even when the working set fits in L2"
type: pattern
architectures: [sm90]
tags: [coalescing, memory-bound, request-amplification]
confidence: verified
sources: [contract:523e38b2f233]
---

## Mechanism

The grid-stride was transposed: thread t walked element t*gridDim.x + blockIdx.x, so the 32 lanes of one warp touched 32 addresses a full grid apart and every load became 32 sectors instead of four. Mapping consecutive threads to consecutive elements cuts the request amplification by 8x with the same arithmetic, the same bytes, and no extra registers or smem.

## Trigger

sectors per request above the ideal (4 for a 4-byte load, 8 for 8-byte) while achieved occupancy is already high and the kernel reads near the memory system's limit

## Measured footprint and cost

no extra registers, smem or bandwidth; the index arithmetic is the same instruction count, so the change is free to keep and free to revert

## Load-bearing conditions

measured at 8 MB, 32 MB and 128 MB working sets on one sm90 card; the amplification is per warp request, so it survives L2 residency. What prevents the fix is a mapping forced by the caller's tensor layout, which needs a transpose and pays the traffic back

## Gotchas

The transposed mapping is still numerically correct, so only a benchmark or a sectors-per-request reading catches it. It also does not look like a bandwidth problem: DRAM throughput can read near peak in both versions, because the cost is the number of sectors requested, not the bytes moved.

## Negative readings

The first hypothesis was wrong. I expected the gap to collapse once the working set fit L2 and wrote that as a load-bearing condition before measuring it. The sweep below killed it: at 8 MB the gap is still 9.9x. L2 residency removes the latency, not the request amplification.

## Reproduce

```
$ nvcc -O3 -arch=sm_90 -DSAXPY_DEFAULT_MODE="coalesced" -o bench bench.cu
$ ./bench --n 16777216 --mode coalesced
METRIC device_ms=0.061417
$ ./bench --n 16777216 --mode strided
METRIC device_ms=0.701747

# the same sweep that falsified the L2 hypothesis (device_ms, coalesced vs strided)
n=1048576   (8 MB)    0.004424   0.043901   ->  9.9x
n=4194304   (32 MB)   0.012256   0.168481   -> 13.7x
n=16777216  (128 MB)  0.061417   0.701747   -> 11.4x
# nounits CSV from nvidia-smi --query-gpu, driver 580.178.04, CUDA 13.0.88
```
