#pragma once
#include <cstdint>
#include <cstddef>
#include <vector>
#include <memory>
typedef enum { kTfLiteOk = 0, kTfLiteError = 1 } TfLiteStatus;
typedef enum { kTfLiteNoType = 0, kTfLiteFloat32 = 1, kTfLiteInt8 = 9 } TfLiteType;
struct TfLiteIntArray { int size; int data[1]; };
struct TfLiteQuantizationParams { float scale; std::int32_t zero_point; };
struct TfLiteTensor {
  TfLiteType type; TfLiteIntArray* dims; std::size_t bytes;
  TfLiteQuantizationParams params;
};
namespace tflite {
class Interpreter {
 public:
  TfLiteStatus AllocateTensors();
  TfLiteStatus Invoke();
  void SetNumThreads(int);
  const std::vector<int>& inputs() const;
  const std::vector<int>& outputs() const;
  TfLiteTensor* tensor(int);
  template <class T> T* typed_tensor(int);
};
}
