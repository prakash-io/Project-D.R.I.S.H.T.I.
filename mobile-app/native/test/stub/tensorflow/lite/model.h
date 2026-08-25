#pragma once
#include <memory>
#include <cstddef>
namespace tflite {
class FlatBufferModel {
 public:
  static std::unique_ptr<FlatBufferModel> BuildFromFile(const char*);
  static std::unique_ptr<FlatBufferModel> BuildFromBuffer(const char*, std::size_t);
};
}
