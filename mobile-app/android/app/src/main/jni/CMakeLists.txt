# App-level native build (New Architecture).
#
# AGP allows exactly ONE externalNativeBuild.cmake.path per module. Pointing
# it straight at our engine's CMakeLists silently replaced React Native's own
# app CMake project, so libappmodules.so was never built — and without it the
# codegen'd core TurboModules (PlatformConstants, ExceptionsManager) are not
# registered, so the app aborts on launch with an EarlyJsError.
#
# This is the documented customization path: own the `appmodules` project,
# include RN's application cmake, then add our library to it. See
# node_modules/react-native/ReactAndroid/cmake-utils/default-app-setup/.
cmake_minimum_required(VERSION 3.13)

# Must stay `appmodules`: DefaultNewArchitectureEntryPoint.load() loads a
# library by that name, and ReactNative-application.cmake keys off
# CMAKE_PROJECT_NAME.
project(appmodules)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# The D.R.I.S.H.T.I. edge engine (MOB-04 / MOB-06). Built as its own
# libdrishti_edge.so, loaded by DrishtiEdgeModule's System.loadLibrary.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../cpp drishti_edge_build)
