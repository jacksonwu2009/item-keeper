// ONNX Runtime C API 的一层薄包装，给 Swift 用。
//
// 为什么包一层：onnxruntime 的 xcframework 没有 module map，Swift 不能直接 import 它的头文件；
// 这里只暴露标准 C 类型（float、int64_t、不透明指针），Swift 通过本模块自己的头文件调用，
// onnxruntime_c_api.h 只在 LabelOcrOrt.c 里引用。
//
// iOS：App 里链接 modules/label-ocr/ios/Frameworks/onnxruntime.xcframework（静态库）。
// macOS：命令行测试工具链接 onnxruntime 的 osx-arm64 动态库（见 ios/tests/run-mac-tests.sh）。
// 两边是同一份代码、同一个 ONNX Runtime 版本。

#ifndef LABEL_OCR_ORT_H
#define LABEL_OCR_ORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#pragma clang assume_nonnull begin

/// 一个加载好的模型（ONNX Runtime 会话）。只用第一个输入、第一个输出，都是 float32。
typedef struct LabelOcrOrtSession LabelOcrOrtSession;

/// 输出张量的副本。data 用 malloc 分配，用完调 label_ocr_ort_output_free。
typedef struct {
  float *_Nullable data;
  size_t count;
  int64_t shape[8];
  size_t rank;
} LabelOcrOrtOutput;

/// ONNX Runtime 库的版本号，例如 "1.21.0"
const char *label_ocr_ort_version(void);

/// 加载模型文件。intraOpThreads ≤ 0 时用 ONNX Runtime 的默认线程数。
/// 失败返回 NULL，原因写进 errorBuffer（UTF-8，带结尾 0）。
LabelOcrOrtSession *_Nullable label_ocr_ort_create(const char *modelPath,
                                                   int intraOpThreads,
                                                   char *errorBuffer,
                                                   size_t errorBufferSize);

/// 跑一次推理：input 的形状是 inputShape[0..<inputRank]。
/// 成功返回 0，输出写进 output；失败返回非 0，原因写进 errorBuffer。
int label_ocr_ort_run(LabelOcrOrtSession *session,
                      const float *input,
                      const int64_t *inputShape,
                      size_t inputRank,
                      LabelOcrOrtOutput *output,
                      char *errorBuffer,
                      size_t errorBufferSize);

void label_ocr_ort_output_free(LabelOcrOrtOutput *output);

void label_ocr_ort_release(LabelOcrOrtSession *_Nullable session);

#pragma clang assume_nonnull end

#ifdef __cplusplus
}
#endif

#endif
