// EKF_TFLite_Bridge.cpp — MOB-06
//
// Feeds the TFLite forward-speed model (MOB-05) into the C++ Extended Kalman
// Filter during a GNSS blackout. The phone pushes IMU samples at 10 Hz; once
// 50 have accumulated (5 s of context) this returns a forward speed in m/s,
// which becomes the EKF's velocity measurement in place of the absent GPS fix.
//
// Build (Android NDK / Objective-C++ both work; C++17 minimum):
//     c++ -std=c++17 -O2 -DNDEBUG -c EKF_TFLite_Bridge.cpp \
//         -I<tflite-root> -I<flatbuffers>/include
//
// Design constraints this file is written against:
//
//   * No allocation, no locking, and no exceptions on the per-sample path.
//     It runs inside the navigation loop; a malloc stall there shows up as
//     position drift, not as a dropped frame.
//
//   * Every failure is a status code. A dead-reckoning filter must never be
//     handed a fabricated speed — returning `kNotReady` and letting the EKF
//     coast on its process model is always better than returning 0.0 and
//     telling it the truck has stopped.
//
//   * The quantisation constants are NOT hardcoded. They are read from
//     speed_model_meta.json at build/init time, because they change on every
//     retrain and a stale scale silently biases every prediction.
//
// Not thread-safe by design. Own it from the single sensor thread, or wrap
// the calls externally; an internal mutex would just hide the contention.

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include "tensorflow/lite/interpreter.h"
#include "tensorflow/lite/kernels/register.h"
#include "tensorflow/lite/model.h"

namespace drishti {

// ---------------------------------------------------------------------------
// Contract with the trained model. These MUST match speed_model_meta.json.
// ---------------------------------------------------------------------------

// Unsigned because every use is an array index or a buffer length; the only
// places these meet a signed value are the TFLite dim checks, which cast
// explicitly. Compiles clean under -Wconversion -Wsign-conversion.
inline constexpr std::size_t kWindow    = 50;  // timesteps (5 s @ 10 Hz)
inline constexpr std::size_t kFeatures  = 6;   // ax, ay, az, gyro yaw/pitch/roll
inline constexpr std::size_t kTensorLen = kWindow * kFeatures;

// Sanity bounds. A phone IMU that reports outside these is faulted, not moving:
// consumer MEMS accelerometers saturate around +/-16 g and gyros around
// +/-35 rad/s. Rejecting is correct -- clamping would feed the filter a
// plausible-looking lie.
inline constexpr float kMaxAbsAccel = 160.0f;  // m/s^2
inline constexpr float kMaxAbsGyro  = 35.0f;   // rad/s

// A ground vehicle in NER terrain. Used only to reject absurd *outputs*.
inline constexpr float kMaxPlausibleSpeed = 60.0f;  // m/s (216 km/h)

enum class Status : std::uint8_t {
    kOk = 0,
    kNotReady,          // fewer than kWindow samples buffered since reset
    kNotInitialised,    // Predict() called before a successful Init()
    kBadModel,          // file missing, not a flatbuffer, or wrong version
    kBadSignature,      // tensor shape or dtype is not what this build expects
    kAllocFailed,       // interpreter could not allocate tensors
    kInvalidSample,     // NaN, infinity, or out-of-range sensor reading
    kInvokeFailed,      // TFLite returned an error during Invoke()
    kImplausible,       // model produced NaN or a physically impossible speed
};

const char* ToString(Status s) noexcept {
    switch (s) {
        case Status::kOk:             return "ok";
        case Status::kNotReady:       return "not_ready";
        case Status::kNotInitialised: return "not_initialised";
        case Status::kBadModel:       return "bad_model";
        case Status::kBadSignature:   return "bad_signature";
        case Status::kAllocFailed:    return "alloc_failed";
        case Status::kInvalidSample:  return "invalid_sample";
        case Status::kInvokeFailed:   return "invoke_failed";
        case Status::kImplausible:    return "implausible";
    }
    return "unknown";
}

/// Per-channel normalisation, copied verbatim from speed_model_meta.json
/// ("normalization"). Order is ax, ay, az, gyro_yaw, gyro_pitch, gyro_roll.
struct Normalisation {
    std::array<float, kFeatures> mean{};
    std::array<float, kFeatures> stddev{};

    /// Rejects a scaler that would divide by ~zero, which would turn a dead
    /// sensor channel into infinities rather than a flat one.
    [[nodiscard]] bool Valid() const noexcept {
        for (std::size_t i = 0; i < kFeatures; ++i) {
            if (!std::isfinite(mean[i]) || !std::isfinite(stddev[i])) return false;
            if (std::fabs(stddev[i]) < 1e-6f) return false;
        }
        return true;
    }
};

// ---------------------------------------------------------------------------

class EkfTFLiteBridge {
  public:
    EkfTFLiteBridge() = default;
    ~EkfTFLiteBridge() = default;

    // The interpreter owns non-copyable state; moving is fine, copying is not.
    EkfTFLiteBridge(const EkfTFLiteBridge&)            = delete;
    EkfTFLiteBridge& operator=(const EkfTFLiteBridge&) = delete;
    EkfTFLiteBridge(EkfTFLiteBridge&&)                 = default;
    EkfTFLiteBridge& operator=(EkfTFLiteBridge&&)      = default;

    /// Load from a file path (Android: extract from assets first; TFLite
    /// cannot mmap an APK entry).
    [[nodiscard]] Status Init(const std::string& model_path,
                              const Normalisation& norm) {
        if (!norm.Valid()) return Status::kBadSignature;
        auto model = tflite::FlatBufferModel::BuildFromFile(model_path.c_str());
        return InitFromModel(std::move(model), norm);
    }

    /// Load from a caller-owned buffer. The buffer must outlive this object —
    /// TFLite reads the flatbuffer in place rather than copying it.
    [[nodiscard]] Status InitFromBuffer(const char* data, std::size_t size,
                                        const Normalisation& norm) {
        if (data == nullptr || size == 0) return Status::kBadModel;
        if (!norm.Valid()) return Status::kBadSignature;
        auto model = tflite::FlatBufferModel::BuildFromBuffer(data, size);
        return InitFromModel(std::move(model), norm);
    }

    /// Push one IMU sample. `sample` is exactly kFeatures floats in the
    /// documented order. Cheap: one bounds check per channel plus a copy.
    [[nodiscard]] Status PushSample(const float (&sample)[kFeatures]) noexcept {
        for (std::size_t i = 0; i < kFeatures; ++i) {
            const float v = sample[i];
            if (!std::isfinite(v)) return Status::kInvalidSample;
            const float limit = (i < 3) ? kMaxAbsAccel : kMaxAbsGyro;
            if (std::fabs(v) > limit) return Status::kInvalidSample;
        }
        std::memcpy(ring_[head_].data(), sample, sizeof(float) * kFeatures);
        head_ = (head_ + 1) % kWindow;
        if (filled_ < kWindow) ++filled_;
        return Status::kOk;
    }

    /// Run the model over the buffered window.
    ///
    /// On kOk, *speed_ms holds the predicted forward speed in metres/second,
    /// clamped at zero: this model has no notion of reversing, and a small
    /// negative output near standstill is regression noise, not motion.
    /// On any other status *speed_ms is left untouched — callers that ignore
    /// the return value get their own initialised value back, not a zero.
    [[nodiscard]] Status Predict(float* speed_ms) noexcept {
        if (speed_ms == nullptr)        return Status::kInvalidSample;
        if (interpreter_ == nullptr)    return Status::kNotInitialised;
        if (filled_ < kWindow)          return Status::kNotReady;

        std::int8_t* in = interpreter_->typed_tensor<std::int8_t>(input_index_);
        if (in == nullptr) return Status::kNotInitialised;

        // Unroll the ring oldest-first. The convolution is not shift-invariant
        // across the buffer seam, so feeding it rotated would be wrong in a way
        // that still produces plausible numbers.
        const std::size_t start = head_;  // head_ points at the oldest slot
        for (std::size_t t = 0; t < kWindow; ++t) {
            const std::array<float, kFeatures>& row = ring_[(start + t) % kWindow];
            const std::size_t base = t * kFeatures;
            for (std::size_t c = 0; c < kFeatures; ++c) {
                const float z = (row[c] - norm_.mean[c]) / norm_.stddev[c];
                in[base + c] = QuantiseInt8(z, in_scale_, in_zero_);
            }
        }

        if (interpreter_->Invoke() != kTfLiteOk) return Status::kInvokeFailed;

        const std::int8_t* out =
            interpreter_->typed_tensor<std::int8_t>(output_index_);
        if (out == nullptr) return Status::kInvokeFailed;

        const float raw =
            (static_cast<float>(out[0]) - static_cast<float>(out_zero_)) * out_scale_;

        if (!std::isfinite(raw) || std::fabs(raw) > kMaxPlausibleSpeed) {
            return Status::kImplausible;
        }
        *speed_ms = std::max(0.0f, raw);
        return Status::kOk;
    }

    /// Drop buffered history. Call on GNSS reacquisition, on a long sensor
    /// gap, or whenever continuity of the 5 s window is broken — stale samples
    /// stitched onto fresh ones fabricate an acceleration that never occurred.
    void Reset() noexcept {
        head_ = 0;
        filled_ = 0;
        for (auto& row : ring_) row.fill(0.0f);
    }

    [[nodiscard]] bool Ready() const noexcept {
        return interpreter_ != nullptr && filled_ >= kWindow;
    }
    [[nodiscard]] std::size_t BufferedSamples() const noexcept { return filled_; }

  private:
    /// Affine quantisation, matching TFLite's reference kernel exactly:
    /// q = round(x / scale) + zero_point, saturating into int8.
    /// std::round (half away from zero) is deliberate — std::nearbyint would
    /// follow the current FP rounding mode and drift from the trained graph.
    [[nodiscard]] static std::int8_t QuantiseInt8(float x, float scale,
                                                  std::int32_t zero) noexcept {
        if (!std::isfinite(x)) return static_cast<std::int8_t>(zero);
        const float scaled = std::round(x / scale) + static_cast<float>(zero);
        // Clamp in float before the cast: converting an out-of-range float to
        // an integer type is undefined behaviour, not a wrap.
        const float clamped = std::min(127.0f, std::max(-128.0f, scaled));
        return static_cast<std::int8_t>(clamped);
    }

    [[nodiscard]] Status InitFromModel(
            std::unique_ptr<tflite::FlatBufferModel> model,
            const Normalisation& norm) {
        if (model == nullptr) return Status::kBadModel;

        tflite::ops::builtin::BuiltinOpResolver resolver;
        std::unique_ptr<tflite::Interpreter> interp;
        if (tflite::InterpreterBuilder(*model, resolver)(&interp) != kTfLiteOk ||
            interp == nullptr) {
            return Status::kBadModel;
        }
        // One thread: this shares a core with the EKF and the UI. Spinning up
        // a TFLite thread pool for a 50x6 input costs more in scheduling than
        // it saves in compute.
        interp->SetNumThreads(1);
        if (interp->AllocateTensors() != kTfLiteOk) return Status::kAllocFailed;

        if (interp->inputs().size() != 1 || interp->outputs().size() != 1) {
            return Status::kBadSignature;
        }
        const int in_idx  = interp->inputs()[0];
        const int out_idx = interp->outputs()[0];
        const TfLiteTensor* in  = interp->tensor(in_idx);
        const TfLiteTensor* out = interp->tensor(out_idx);
        if (in == nullptr || out == nullptr) return Status::kBadSignature;

        // Guard against the float model being shipped by mistake: it loads and
        // runs, but every int8 write below would be reinterpreted as garbage.
        if (in->type != kTfLiteInt8 || out->type != kTfLiteInt8) {
            return Status::kBadSignature;
        }
        // Expect [1, kWindow, kFeatures]; a retrain with a different window
        // must fail loudly here rather than read past the tensor.
        if (in->dims == nullptr || in->dims->size != 3 ||
            in->dims->data[0] != 1 ||
            in->dims->data[1] != static_cast<int>(kWindow) ||
            in->dims->data[2] != static_cast<int>(kFeatures)) {
            return Status::kBadSignature;
        }
        // int8 means one byte per element, so bytes and element count coincide.
        if (in->bytes != kTensorLen) {
            return Status::kBadSignature;
        }
        if (out->dims == nullptr || out->dims->size < 1) return Status::kBadSignature;

        // A full-integer graph always carries per-tensor scales. A zero scale
        // would make dequantisation collapse every prediction to zero.
        if (in->params.scale <= 0.0f || out->params.scale <= 0.0f) {
            return Status::kBadSignature;
        }

        model_        = std::move(model);
        interpreter_  = std::move(interp);
        input_index_  = in_idx;
        output_index_ = out_idx;
        in_scale_     = in->params.scale;
        in_zero_      = in->params.zero_point;
        out_scale_    = out->params.scale;
        out_zero_     = out->params.zero_point;
        norm_         = norm;
        Reset();
        return Status::kOk;
    }

    // Declared before interpreter_: the interpreter borrows the flatbuffer, so
    // the model must outlive it. Member destruction is reverse of declaration.
    std::unique_ptr<tflite::FlatBufferModel> model_;
    std::unique_ptr<tflite::Interpreter>     interpreter_;

    int input_index_  = -1;
    int output_index_ = -1;

    float        in_scale_  = 0.0f;
    std::int32_t in_zero_   = 0;
    float        out_scale_ = 0.0f;
    std::int32_t out_zero_  = 0;

    Normalisation norm_{};

    // Ring buffer of the last kWindow samples. head_ is both the next write
    // slot and, once full, the oldest sample.
    std::array<std::array<float, kFeatures>, kWindow> ring_{};
    std::size_t head_   = 0;
    std::size_t filled_ = 0;
};

}  // namespace drishti

// ---------------------------------------------------------------------------
// Usage — the dark-zone loop
// ---------------------------------------------------------------------------
//
//   #include "SpeedModelParams.h"   // generated by scripts/gen_model_header.py
//   using namespace drishti;
//
//   // Never hand-copy these. A retrain shifts the means, the header goes
//   // stale, and every prediction is biased by a constant nothing can catch.
//   static_assert(kParamWindow == kWindow && kParamFeatures == kFeatures,
//                 "SpeedModelParams.h was generated for a different geometry");
//
//   Normalisation norm;
//   norm.mean   = kFeatureMean;
//   norm.stddev = kFeatureStd;
//
//   EkfTFLiteBridge bridge;
//   if (const Status s = bridge.Init(model_path, norm); s != Status::kOk) {
//       LOGE("speed model unavailable: %s", ToString(s));
//       return;                                // EKF falls back to wheel odometry
//   }
//
//   // 10 Hz sensor callback
//   const float sample[kFeatures] = {ax, ay, az, gyro_yaw, gyro_pitch, gyro_roll};
//   if (bridge.PushSample(sample) != Status::kOk) {
//       bridge.Reset();                        // faulted IMU: drop the window
//       return;
//   }
//
//   float speed_ms = 0.0f;
//   switch (bridge.Predict(&speed_ms)) {
//       case Status::kOk:
//           ekf.UpdateVelocity(speed_ms, kSpeedMeasurementVariance);
//           break;
//       case Status::kNotReady:
//           break;                             // still filling the first 5 s
//       default:
//           // Coast on the process model. Never inject 0.0 here: to the EKF
//           // that is a measurement saying the vehicle has stopped, and it
//           // will confidently hold position while the truck drives away.
//           break;
//   }
