// Minimal TFLite stand-in: an identity int8 model with known scales, enough
// to exercise the bridge's buffering, normalisation and quantisation paths.
#include "tensorflow/lite/interpreter.h"
#include "tensorflow/lite/kernels/register.h"
#include <vector>
#include <cstring>

static TfLiteIntArray* g_in_dims = nullptr;
static TfLiteTensor g_in{}, g_out{};
static std::vector<signed char> g_in_buf(50 * 6), g_out_buf(1);
static std::vector<int> g_inputs{0}, g_outputs{1};
std::vector<signed char>& StubInputBuffer() { return g_in_buf; }
std::vector<signed char>& StubOutputBuffer() { return g_out_buf; }

namespace tflite {
TfLiteStatus Interpreter::AllocateTensors() {
  if (!g_in_dims) {
    g_in_dims = (TfLiteIntArray*)malloc(sizeof(TfLiteIntArray) + 2 * sizeof(int));
    g_in_dims->size = 3;
    g_in_dims->data[0] = 1; g_in_dims->data[1] = 50; g_in_dims->data[2] = 6;
  }
  g_in.type = kTfLiteInt8; g_in.dims = g_in_dims; g_in.bytes = 300;
  g_in.params.scale = 0.05f; g_in.params.zero_point = -3;
  static TfLiteIntArray od{1, {1}};
  g_out.type = kTfLiteInt8; g_out.dims = &od; g_out.bytes = 1;
  g_out.params.scale = 0.25f; g_out.params.zero_point = -10;
  return kTfLiteOk;
}
TfLiteStatus Interpreter::Invoke() { return kTfLiteOk; }
void Interpreter::SetNumThreads(int) {}
const std::vector<int>& Interpreter::inputs() const { return g_inputs; }
const std::vector<int>& Interpreter::outputs() const { return g_outputs; }
TfLiteTensor* Interpreter::tensor(int i) { return i == 0 ? &g_in : &g_out; }
template <> signed char* Interpreter::typed_tensor<signed char>(int i) {
  return i == 0 ? g_in_buf.data() : g_out_buf.data();
}
std::unique_ptr<FlatBufferModel> FlatBufferModel::BuildFromFile(const char*) {
  return std::unique_ptr<FlatBufferModel>(new FlatBufferModel());
}
std::unique_ptr<FlatBufferModel> FlatBufferModel::BuildFromBuffer(const char*, std::size_t) {
  return std::unique_ptr<FlatBufferModel>(new FlatBufferModel());
}
InterpreterBuilder::InterpreterBuilder(const FlatBufferModel&, const ops::builtin::BuiltinOpResolver&) {}
TfLiteStatus InterpreterBuilder::operator()(std::unique_ptr<Interpreter>* p) {
  p->reset(new Interpreter()); return kTfLiteOk;
}
}
