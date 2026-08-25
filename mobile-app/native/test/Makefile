# Runs the bridge's logic without the NDK or a real TFLite build.
#
# The stub/ headers mirror just enough of the TFLite C++ API to compile, and
# stub_impl.cpp stands in for an int8 model with known scales. That makes the
# parts most likely to be wrong -- ring-buffer ordering, normalisation, the
# quantise/dequantise round-trip -- testable on a laptop.
#
#     make       build and run
#     make strict  compile the bridge under the full warning set
CXXFLAGS = -std=c++17 -O1 -Wall -Wextra -I stub -I ..

test_bridge: test_bridge.cpp stub_impl.cpp ../EKF_TFLite_Bridge.cpp
	$(CXX) $(CXXFLAGS) test_bridge.cpp stub_impl.cpp -o $@

.PHONY: run strict clean
run: test_bridge
	./test_bridge

strict:
	$(CXX) -std=c++17 -fsyntax-only -Wall -Wextra -Wpedantic -Wshadow \
	    -Wconversion -Wsign-conversion -Wold-style-cast \
	    -I stub ../EKF_TFLite_Bridge.cpp && echo "clean under strict warnings"

clean:
	rm -f test_bridge
