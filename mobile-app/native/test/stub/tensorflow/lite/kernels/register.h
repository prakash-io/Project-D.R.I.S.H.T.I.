#pragma once
#include "tensorflow/lite/model.h"
#include "tensorflow/lite/interpreter.h"
#include <memory>
namespace tflite {
namespace ops { namespace builtin { class BuiltinOpResolver {}; } }
class InterpreterBuilder {
 public:
  InterpreterBuilder(const FlatBufferModel&, const ops::builtin::BuiltinOpResolver&);
  TfLiteStatus operator()(std::unique_ptr<Interpreter>*);
};
}
