// 见 LabelOcrOrt.h。所有 ONNX Runtime 调用都在这里。

#include "LabelOcrOrt.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// iOS 上头文件在 onnxruntime.framework/Headers 里（<onnxruntime/...>）；macOS 测试时直接用 -I 指到头文件目录
#if __has_include(<onnxruntime/onnxruntime_c_api.h>)
#include <onnxruntime/onnxruntime_c_api.h>
#else
#include <onnxruntime_c_api.h>
#endif

struct LabelOcrOrtSession {
  OrtSession *session;
  char *inputName;
  char *outputName;
};

static const OrtApi *gApi = NULL;
static OrtEnv *gEnv = NULL;
static OrtMemoryInfo *gMemoryInfo = NULL;
static char gInitError[512];
static pthread_once_t gInitOnce = PTHREAD_ONCE_INIT;

static void writeError(char *buffer, size_t size, const char *prefix, const char *detail) {
  if (size == 0) return;
  snprintf(buffer, size, "%s%s", prefix, detail ? detail : "");
}

/// 有错误时把说明写进 buffer、释放 status，返回 1；没错返回 0
static int takeStatus(OrtStatus *status, char *buffer, size_t size, const char *prefix) {
  if (status == NULL) return 0;
  writeError(buffer, size, prefix, gApi->GetErrorMessage(status));
  gApi->ReleaseStatus(status);
  return 1;
}

static void initOnce(void) {
  const OrtApiBase *base = OrtGetApiBase();
  gApi = base->GetApi(ORT_API_VERSION);
  if (gApi == NULL) {
    snprintf(gInitError, sizeof gInitError, "ONNX Runtime 库（%s）不支持接口版本 %d", base->GetVersionString(),
             ORT_API_VERSION);
    return;
  }
  OrtStatus *status = gApi->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "label-ocr", &gEnv);
  if (status == NULL) {
    status = gApi->CreateCpuMemoryInfo(OrtDeviceAllocator, OrtMemTypeDefault, &gMemoryInfo);
  }
  if (status != NULL) {
    snprintf(gInitError, sizeof gInitError, "ONNX Runtime 初始化失败：%s", gApi->GetErrorMessage(status));
    gApi->ReleaseStatus(status);
    gEnv = NULL;
  }
}

static int ensureInit(char *buffer, size_t size) {
  pthread_once(&gInitOnce, initOnce);
  if (gApi == NULL || gEnv == NULL || gMemoryInfo == NULL) {
    writeError(buffer, size, "", gInitError);
    return 1;
  }
  return 0;
}

const char *label_ocr_ort_version(void) {
  return OrtGetApiBase()->GetVersionString();
}

static char *copyName(OrtSession *session, int input, OrtAllocator *allocator, char *buffer, size_t size) {
  char *name = NULL;
  OrtStatus *status = input ? gApi->SessionGetInputName(session, 0, allocator, &name)
                            : gApi->SessionGetOutputName(session, 0, allocator, &name);
  if (takeStatus(status, buffer, size, input ? "读不到模型输入名：" : "读不到模型输出名：")) return NULL;
  char *copy = strdup(name);
  OrtStatus *freeStatus = gApi->AllocatorFree(allocator, name);
  if (freeStatus != NULL) gApi->ReleaseStatus(freeStatus);
  return copy;
}

LabelOcrOrtSession *label_ocr_ort_create(const char *modelPath, int intraOpThreads, char *errorBuffer,
                                         size_t errorBufferSize) {
  if (ensureInit(errorBuffer, errorBufferSize)) return NULL;

  OrtSessionOptions *options = NULL;
  if (takeStatus(gApi->CreateSessionOptions(&options), errorBuffer, errorBufferSize, "创建会话选项失败：")) return NULL;

  // 和安卓一样：图优化全开；线程数由调用方给；输入大小每次不一样，不留内存池，用完把大块内存还给系统
  OrtStatus *status = gApi->SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL);
  if (status == NULL && intraOpThreads > 0) status = gApi->SetIntraOpNumThreads(options, intraOpThreads);
  if (status == NULL) status = gApi->DisableCpuMemArena(options);
  if (status == NULL) status = gApi->DisableMemPattern(options);
  if (takeStatus(status, errorBuffer, errorBufferSize, "设置会话选项失败：")) {
    gApi->ReleaseSessionOptions(options);
    return NULL;
  }

  OrtSession *session = NULL;
  status = gApi->CreateSession(gEnv, modelPath, options, &session);
  gApi->ReleaseSessionOptions(options);
  if (takeStatus(status, errorBuffer, errorBufferSize, "加载模型失败：")) return NULL;

  OrtAllocator *allocator = NULL;
  if (takeStatus(gApi->GetAllocatorWithDefaultOptions(&allocator), errorBuffer, errorBufferSize, "取分配器失败：")) {
    gApi->ReleaseSession(session);
    return NULL;
  }
  char *inputName = copyName(session, 1, allocator, errorBuffer, errorBufferSize);
  char *outputName = inputName ? copyName(session, 0, allocator, errorBuffer, errorBufferSize) : NULL;
  if (inputName == NULL || outputName == NULL) {
    free(inputName);
    gApi->ReleaseSession(session);
    return NULL;
  }

  LabelOcrOrtSession *wrapper = calloc(1, sizeof(LabelOcrOrtSession));
  if (wrapper == NULL) {
    free(inputName);
    free(outputName);
    gApi->ReleaseSession(session);
    writeError(errorBuffer, errorBufferSize, "内存不够", NULL);
    return NULL;
  }
  wrapper->session = session;
  wrapper->inputName = inputName;
  wrapper->outputName = outputName;
  return wrapper;
}

int label_ocr_ort_run(LabelOcrOrtSession *session, const float *input, const int64_t *inputShape, size_t inputRank,
                      LabelOcrOrtOutput *output, char *errorBuffer, size_t errorBufferSize) {
  memset(output, 0, sizeof *output);
  if (ensureInit(errorBuffer, errorBufferSize)) return 1;

  size_t inputCount = 1;
  for (size_t i = 0; i < inputRank; i++) inputCount *= (size_t)inputShape[i];

  OrtValue *inputValue = NULL;
  // ONNX Runtime 不会改输入数据，这里去掉 const 只是为了对上函数签名
  OrtStatus *status = gApi->CreateTensorWithDataAsOrtValue(gMemoryInfo, (void *)input, inputCount * sizeof(float),
                                                           inputShape, inputRank,
                                                           ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &inputValue);
  if (takeStatus(status, errorBuffer, errorBufferSize, "创建输入张量失败：")) return 1;

  const char *inputNames[1] = {session->inputName};
  const char *outputNames[1] = {session->outputName};
  OrtValue *outputValue = NULL;
  status = gApi->Run(session->session, NULL, inputNames, (const OrtValue *const *)&inputValue, 1, outputNames, 1,
                     &outputValue);
  gApi->ReleaseValue(inputValue);
  if (takeStatus(status, errorBuffer, errorBufferSize, "推理失败：")) return 1;

  OrtTensorTypeAndShapeInfo *info = NULL;
  float *data = NULL;
  size_t rank = 0;
  size_t count = 0;
  status = gApi->GetTensorTypeAndShape(outputValue, &info);
  if (status == NULL) status = gApi->GetDimensionsCount(info, &rank);
  if (status == NULL && rank > 8) {
    gApi->ReleaseTensorTypeAndShapeInfo(info);
    gApi->ReleaseValue(outputValue);
    writeError(errorBuffer, errorBufferSize, "输出维数太多", NULL);
    return 1;
  }
  if (status == NULL) status = gApi->GetDimensions(info, output->shape, rank);
  if (status == NULL) status = gApi->GetTensorShapeElementCount(info, &count);
  if (status == NULL) status = gApi->GetTensorMutableData(outputValue, (void **)&data);
  if (info != NULL) gApi->ReleaseTensorTypeAndShapeInfo(info);
  if (takeStatus(status, errorBuffer, errorBufferSize, "读输出失败：")) {
    gApi->ReleaseValue(outputValue);
    return 1;
  }

  output->data = malloc(count * sizeof(float) + 1);
  if (output->data == NULL) {
    gApi->ReleaseValue(outputValue);
    writeError(errorBuffer, errorBufferSize, "内存不够", NULL);
    return 1;
  }
  memcpy(output->data, data, count * sizeof(float));
  output->count = count;
  output->rank = rank;
  gApi->ReleaseValue(outputValue);
  return 0;
}

void label_ocr_ort_output_free(LabelOcrOrtOutput *output) {
  free(output->data);
  output->data = NULL;
  output->count = 0;
}

void label_ocr_ort_release(LabelOcrOrtSession *session) {
  if (session == NULL) return;
  if (gApi != NULL) gApi->ReleaseSession(session->session);
  free(session->inputName);
  free(session->outputName);
  free(session);
}
