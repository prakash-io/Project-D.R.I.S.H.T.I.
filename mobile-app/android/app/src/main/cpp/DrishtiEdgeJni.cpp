// JNI shim (MOB-04). Marshals only -- all sequencing lives in EdgeEngineApi.
//
// The engine handle is a jlong rather than a global: one tracker, one engine,
// and a long that JS holds cannot be garbage collected out from under a
// sensor callback.
#include <jni.h>

#include <string>

#include "EdgeEngineApi.h"

namespace {

std::string ToStdString(JNIEnv* env, jstring value) {
    if (value == nullptr) return {};
    const char* chars = env->GetStringUTFChars(value, nullptr);
    std::string out = (chars != nullptr) ? chars : "";
    if (chars != nullptr) env->ReleaseStringUTFChars(value, chars);
    return out;
}

DrishtiEdgeEngine* AsEngine(jlong handle) {
    return reinterpret_cast<DrishtiEdgeEngine*>(handle);
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeCreate(JNIEnv* env, jclass,
                                                     jstring graph_path,
                                                     jstring model_path) {
    const std::string graph = ToStdString(env, graph_path);
    const std::string model = ToStdString(env, model_path);
    return reinterpret_cast<jlong>(
        DrishtiEdge_Create(graph.empty() ? nullptr : graph.c_str(),
                           model.empty() ? nullptr : model.c_str()));
}

JNIEXPORT void JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeDestroy(JNIEnv*, jclass, jlong handle) {
    DrishtiEdge_Destroy(AsEngine(handle));
}

JNIEXPORT void JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeReset(JNIEnv*, jclass, jlong handle,
                                                    jdouble lat, jdouble lon,
                                                    jdouble heading, jdouble speed,
                                                    jdouble timestamp) {
    DrishtiEdge_Reset(AsEngine(handle), lat, lon, heading, speed, timestamp);
}

JNIEXPORT jboolean JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativePushImu(JNIEnv*, jclass, jlong handle,
                                                      jfloat ax, jfloat ay, jfloat az,
                                                      jfloat gyaw, jfloat gpitch,
                                                      jfloat groll, jdouble timestamp) {
    return DrishtiEdge_PushImu(AsEngine(handle), ax, ay, az, gyaw, gpitch, groll,
                               timestamp) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeUpdateSpeed(JNIEnv*, jclass, jlong handle,
                                                          jdouble speed) {
    DrishtiEdge_UpdateSpeed(AsEngine(handle), speed);
}

JNIEXPORT jboolean JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeMapMatch(JNIEnv*, jclass, jlong handle,
                                                       jdouble max_distance_m) {
    return DrishtiEdge_MapMatch(AsEngine(handle), max_distance_m) ? JNI_TRUE : JNI_FALSE;
}

/// Fills a caller-supplied double[7] plus a boolean[2]. Returning a Java
/// object per fix would allocate 10 times a second for the whole blackout.
JNIEXPORT void JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeGetFix(JNIEnv* env, jclass, jlong handle,
                                                     jdoubleArray out_numbers,
                                                     jbooleanArray out_flags) {
    DrishtiEdgeFix fix{};
    DrishtiEdge_GetFix(AsEngine(handle), &fix);

    jdouble numbers[7] = {fix.latitude, fix.longitude, fix.heading_deg, fix.speed_mps,
                          fix.covariance_m2, fix.timestamp_s,
                          static_cast<jdouble>(fix.matched_edge_id)};
    jboolean flags[2] = {static_cast<jboolean>(fix.map_matched),
                         static_cast<jboolean>(fix.valid)};

    if (out_numbers != nullptr && env->GetArrayLength(out_numbers) >= 7) {
        env->SetDoubleArrayRegion(out_numbers, 0, 7, numbers);
    }
    if (out_flags != nullptr && env->GetArrayLength(out_flags) >= 2) {
        env->SetBooleanArrayRegion(out_flags, 0, 2, flags);
    }
}

JNIEXPORT jboolean JNICALL
Java_com_drishti_edge_DrishtiEdgeModule_nativeHasGraph(JNIEnv*, jclass, jlong handle) {
    return DrishtiEdge_HasGraph(AsEngine(handle)) ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"
