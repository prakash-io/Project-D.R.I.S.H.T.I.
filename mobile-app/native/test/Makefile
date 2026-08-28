# Runs the bridge's logic without the NDK or a real TFLite build.
#
# The stub/ headers mirror just enough of the TFLite C++ API to compile, and
# stub_impl.cpp stands in for an int8 model with known scales. That makes the
# parts most likely to be wrong -- ring-buffer ordering, normalisation, the
# quantise/dequantise round-trip -- testable on a laptop.
#
# test_dead_reckoning covers the EKF (MOB-04) and the map matcher (MOB-06)
# against the REAL road_graph.sqlite -- no stub, because the thing being
# proved is that sqlite and the R*Tree behave on the shipped 104 MB extract.
#
#     make          build and run both suites
#     make run-dr   just the EKF / map-matcher suite
#     make strict   compile everything under the full warning set
CXXFLAGS = -std=c++17 -O1 -Wall -Wextra -I stub -I ..

# Eigen is -isystem, not -I: its own headers are not warning-clean under
# -Wconversion, and burying our warnings under theirs defeats the purpose.
EIGEN_INC ?= /opt/homebrew/include/eigen3
DR_FLAGS = -std=c++17 -O1 -Wall -Wextra -I .. -isystem $(EIGEN_INC)
GRAPH ?= ../../../data/artifacts/edge/road_graph.sqlite

test_bridge: test_bridge.cpp stub_impl.cpp ../EKF_TFLite_Bridge.cpp
	$(CXX) $(CXXFLAGS) test_bridge.cpp stub_impl.cpp -o $@

test_dead_reckoning: test_dead_reckoning.cpp ../DeadReckoning.cpp ../MapMatcher.cpp \
                     ../EdgeEngineApi.cpp ../DeadReckoning.h ../MapMatcher.h \
                     ../EdgeEngineApi.h ../Geo.h ../IMU_Constants.h
	$(CXX) $(DR_FLAGS) test_dead_reckoning.cpp ../DeadReckoning.cpp ../MapMatcher.cpp \
	    ../EdgeEngineApi.cpp -lsqlite3 -o $@

# Reads a synthetic IMU stream on stdin and prints the track the real engine
# produces. Driven by mobile-app/test/dark_zone_track.test.mjs, which
# generates the stream from a real corridor and checks the track stays on it.
sim_drive_track: sim_drive_track.cpp ../DeadReckoning.cpp ../MapMatcher.cpp \
                 ../EdgeEngineApi.cpp ../DeadReckoning.h ../MapMatcher.h \
                 ../EdgeEngineApi.h ../Geo.h ../IMU_Constants.h
	$(CXX) $(DR_FLAGS) sim_drive_track.cpp ../DeadReckoning.cpp ../MapMatcher.cpp \
	    ../EdgeEngineApi.cpp -lsqlite3 -o $@

.PHONY: run run-dr strict clean
run: test_bridge test_dead_reckoning
	./test_bridge
	./test_dead_reckoning $(GRAPH)

run-dr: test_dead_reckoning
	./test_dead_reckoning $(GRAPH)

strict:
	$(CXX) -std=c++17 -fsyntax-only -Wall -Wextra -Wpedantic -Wshadow \
	    -Wconversion -Wsign-conversion -Wold-style-cast \
	    -I stub ../EKF_TFLite_Bridge.cpp
	$(CXX) -std=c++17 -fsyntax-only -Wall -Wextra -Wpedantic -Wshadow \
	    -Wconversion -Wsign-conversion -Wold-style-cast \
	    -I .. -isystem $(EIGEN_INC) ../DeadReckoning.cpp ../MapMatcher.cpp ../EdgeEngineApi.cpp
	@echo "clean under strict warnings"

clean:
	rm -f test_bridge test_dead_reckoning sim_drive_track
