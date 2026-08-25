#include "EKF_TFLite_Bridge.cpp"
#include <cstdio>
#include <vector>
#include <cmath>
extern std::vector<signed char>& StubInputBuffer();
extern std::vector<signed char>& StubOutputBuffer();

using namespace drishti;
static int fails = 0;
#define CHECK(c, msg) do { if (!(c)) { std::printf("  FAIL %s\n", msg); ++fails; } \
                           else std::printf("  ok   %s\n", msg); } while (0)

int main() {
    Normalisation norm;
    norm.mean   = {0.0f, 0.0f, 9.8f, 0.0f, 0.0f, 0.0f};
    norm.stddev = {1.0f, 1.0f, 0.5f, 0.1f, 0.1f, 0.1f};

    std::printf("normalisation validation\n");
    Normalisation bad = norm; bad.stddev[2] = 0.0f;
    EkfTFLiteBridge b0;
    CHECK(b0.Init("x", bad) == Status::kBadSignature, "zero stddev rejected");
    bad = norm; bad.mean[0] = std::nanf("");
    CHECK(b0.Init("x", bad) == Status::kBadSignature, "NaN mean rejected");

    EkfTFLiteBridge b;
    std::printf("\nlifecycle\n");
    float out = -999.0f;
    CHECK(b.Predict(&out) == Status::kNotInitialised, "Predict before Init");
    CHECK(b.Init("dummy.tflite", norm) == Status::kOk, "Init succeeds");
    CHECK(b.BufferedSamples() == 0, "buffer starts empty");
    CHECK(!b.Ready(), "not ready before 50 samples");

    std::printf("\nsample validation\n");
    float nan_s[6] = {std::nanf(""), 0, 9.8f, 0, 0, 0};
    CHECK(b.PushSample(nan_s) == Status::kInvalidSample, "NaN sample rejected");
    float inf_s[6] = {0, INFINITY, 9.8f, 0, 0, 0};
    CHECK(b.PushSample(inf_s) == Status::kInvalidSample, "inf sample rejected");
    float big_a[6] = {500.0f, 0, 9.8f, 0, 0, 0};
    CHECK(b.PushSample(big_a) == Status::kInvalidSample, "saturated accel rejected");
    float big_g[6] = {0, 0, 9.8f, 99.0f, 0, 0};
    CHECK(b.PushSample(big_g) == Status::kInvalidSample, "saturated gyro rejected");
    CHECK(b.BufferedSamples() == 0, "rejected samples did not enter buffer");

    std::printf("\nwindow fill\n");
    for (int i = 0; i < 49; ++i) {
        float s[6] = {0, 0, 9.8f, 0, 0, 0};
        (void)b.PushSample(s);
    }
    CHECK(b.BufferedSamples() == 49, "49 buffered");
    out = -999.0f;
    CHECK(b.Predict(&out) == Status::kNotReady, "kNotReady at 49 samples");
    CHECK(out == -999.0f, "out untouched when not ready");

    // 50th sample is distinctive so we can find it in the tensor.
    float last[6] = {1.0f, 0, 9.8f, 0, 0, 0};
    (void)b.PushSample(last);
    CHECK(b.Ready(), "ready at 50");
    CHECK(b.Predict(&out) == Status::kOk, "Predict ok at 50");

    std::printf("\nring buffer ordering (oldest-first unroll)\n");
    // ax=1.0 -> z=(1.0-0)/1.0=1.0 -> q=round(1.0/0.05)+(-3)=20-3=17
    const auto& in = StubInputBuffer();
    CHECK(in[49 * 6 + 0] == 17, "newest sample lands in LAST timestep slot");
    CHECK(in[0] == -3, "oldest slot holds ax=0 -> zero_point");
    // az=9.8 -> z=(9.8-9.8)/0.5=0 -> q=0+(-3)=-3
    CHECK(in[49 * 6 + 2] == -3, "az normalises to exactly zero");

    std::printf("\nquantisation round-trip\n");
    // out int8 = 40 -> (40 - (-10)) * 0.25 = 12.5 m/s
    StubOutputBuffer()[0] = 40;
    CHECK(b.Predict(&out) == Status::kOk, "predict ok");
    CHECK(std::fabs(out - 12.5f) < 1e-6f, "dequantised 40 -> 12.5 m/s");
    // negative regression output clamps to 0, never negative speed
    StubOutputBuffer()[0] = -100;   // (-100 + 10) * 0.25 = -22.5
    CHECK(b.Predict(&out) == Status::kOk, "negative output accepted");
    CHECK(out == 0.0f, "negative speed clamped to zero");
    // absurd output rejected rather than fed to the EKF
    StubOutputBuffer()[0] = 127;    // (127+10)*0.25 = 34.25 -> plausible
    CHECK(b.Predict(&out) == Status::kOk, "34.25 m/s still plausible");

    std::printf("\nreset\n");
    b.Reset();
    CHECK(b.BufferedSamples() == 0, "Reset clears buffer");
    CHECK(!b.Ready(), "not ready after Reset");
    CHECK(b.Predict(&out) == Status::kNotReady, "Predict blocked after Reset");

    std::printf("\nnull guard\n");
    CHECK(b.Predict(nullptr) == Status::kInvalidSample, "null out pointer rejected");

    std::printf("\n%s\n", fails ? "FAILURES" : "all checks passed");
    return fails ? 1 : 0;
}
