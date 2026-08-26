# D.R.I.S.H.T.I. edge engine — Android/NDK build (MOB-04, MOB-06).
#
# The engine sources are NOT copied here. They stay in mobile-app/native/ and
# are referenced by path, because three consumers compile the same files:
#
#   * this NDK build            -> libdrishti_edge.so
#   * mobile-app/native/test/   -> the 54 host checks (make run)
#   * mobile-app/ios/           -> DrishtiEdge.mm
#
# Duplicating the .cpp into android/ would let the EKF drift between the
# thing that is tested on the laptop and the thing that ships on the handset.
cmake_minimum_required(VERSION 3.22.1)
project(drishti_edge CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# cpp -> main -> src -> app -> android -> mobile-app
get_filename_component(MOBILE_APP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)
set(NATIVE_DIR "${MOBILE_APP_DIR}/native")

if(NOT EXISTS "${NATIVE_DIR}/EdgeEngineApi.cpp")
    message(FATAL_ERROR "Edge engine sources not found at ${NATIVE_DIR}")
endif()

# --- Eigen (header-only, so the host copy cross-compiles fine) --------------
# Override from Gradle with -DDRISHTI_EIGEN_DIR=/path/to/eigen3 if needed.
if(NOT DRISHTI_EIGEN_DIR)
    foreach(candidate
            "${MOBILE_APP_DIR}/third_party/eigen3"
            "/opt/homebrew/include/eigen3"
            "/usr/local/include/eigen3"
            "/usr/include/eigen3")
        if(EXISTS "${candidate}/Eigen/Dense")
            set(DRISHTI_EIGEN_DIR "${candidate}")
            break()
        endif()
    endforeach()
endif()
if(NOT DRISHTI_EIGEN_DIR OR NOT EXISTS "${DRISHTI_EIGEN_DIR}/Eigen/Dense")
    message(FATAL_ERROR
        "Eigen not found. Install it (brew install eigen) or pass "
        "-DDRISHTI_EIGEN_DIR=<dir containing Eigen/Dense>.")
endif()
message(STATUS "drishti: Eigen at ${DRISHTI_EIGEN_DIR}")

# --- SQLite ----------------------------------------------------------------
# The NDK sysroot ships no sqlite3.h and no libsqlite3: Android's system
# SQLite is not an NDK-public library. The map matcher needs R*Tree, so the
# amalgamation is vendored and compiled into the .so.
add_library(drishti_sqlite STATIC "${MOBILE_APP_DIR}/third_party/sqlite/sqlite3.c")
target_include_directories(drishti_sqlite PUBLIC "${MOBILE_APP_DIR}/third_party/sqlite")
target_compile_definitions(drishti_sqlite PRIVATE
    SQLITE_ENABLE_RTREE=1      # road_edges_rtree — the map matcher's index
    SQLITE_THREADSAFE=1
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_OMIT_LOAD_EXTENSION=1
    SQLITE_DQS=0)
set_target_properties(drishti_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)

# --- The engine ------------------------------------------------------------
add_library(drishti_edge SHARED
    "${NATIVE_DIR}/DeadReckoning.cpp"     # EKF (MOB-04)
    "${NATIVE_DIR}/MapMatcher.cpp"        # R*Tree snap (MOB-06)
    "${NATIVE_DIR}/EdgeEngineApi.cpp"     # flat C API — the sequencing
    "${CMAKE_CURRENT_SOURCE_DIR}/DrishtiEdgeJni.cpp")

target_include_directories(drishti_edge PRIVATE "${NATIVE_DIR}")
# Eigen is SYSTEM: its headers are not clean under our warning set, and
# burying our own warnings under Eigen's defeats the point.
target_include_directories(drishti_edge SYSTEM PRIVATE "${DRISHTI_EIGEN_DIR}")
target_compile_options(drishti_edge PRIVATE -Wall -Wextra)
target_link_libraries(drishti_edge drishti_sqlite log)

# --- TFLite speed model (MOB-05), off by default ---------------------------
# EKF_TFLite_Bridge.cpp includes <tensorflow/lite/interpreter.h> — the C++
# API, which upstream does not publish as an Android prebuilt (the
# org.tensorflow:tensorflow-lite AAR exposes the C API only). Until a TFLite
# C++ build is supplied, this target stays off and the .so builds without it;
# EdgeEngineApi does not reference the bridge, so the EKF and map matcher are
# unaffected. Turn on with -DDRISHTI_WITH_TFLITE=ON -DDRISHTI_TFLITE_DIR=...
option(DRISHTI_WITH_TFLITE "Compile the TFLite speed-model bridge" OFF)
if(DRISHTI_WITH_TFLITE)
    if(NOT DRISHTI_TFLITE_DIR)
        message(FATAL_ERROR "DRISHTI_WITH_TFLITE=ON requires DRISHTI_TFLITE_DIR")
    endif()
    target_sources(drishti_edge PRIVATE "${NATIVE_DIR}/EKF_TFLite_Bridge.cpp")
    target_include_directories(drishti_edge SYSTEM PRIVATE "${DRISHTI_TFLITE_DIR}/include")
    find_library(TFLITE_LIB tensorflowlite HINTS "${DRISHTI_TFLITE_DIR}/lib/${ANDROID_ABI}" REQUIRED)
    target_link_libraries(drishti_edge ${TFLITE_LIB})
    message(STATUS "drishti: TFLite bridge ENABLED from ${DRISHTI_TFLITE_DIR}")
else()
    message(STATUS "drishti: TFLite bridge disabled (see MOB-05)")
endif()
