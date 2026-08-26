// Edge-engine asset extraction (MOB-04, MOB-06).
//
// The C++ engine opens the road graph with sqlite3_open_v2 and the model with
// a file path. Neither can read an APK entry: Android assets live inside the
// zip, and the NDK has no handle to them. So the two files are copied out to
// DocumentDirectoryPath once, on first launch, and the engine is handed the
// extracted paths.
//
// RNFS.MainBundlePath is iOS-only -- the Android RNFS module never defines
// RNFSMainBundlePath, so it is `undefined` there and any path built from it
// becomes the literal string "undefined/road_graph.sqlite". That is what the
// engine was previously being given.
import { Platform } from 'react-native';
import RNFS from 'react-native-fs';

const ASSETS = ['road_graph.sqlite', 'speed_model.tflite'];

/**
 * Ensure both assets exist on the filesystem and return their paths.
 *
 * Copies via a `.part` file and renames on completion. A half-written graph
 * is worse than a missing one: sqlite would open it and the map matcher would
 * silently match against a truncated R*Tree.
 */
export async function ensureEdgeAssets() {
  const dir = RNFS.DocumentDirectoryPath;
  const paths = {};

  for (const name of ASSETS) {
    const destination = `${dir}/${name}`;

    if (await RNFS.exists(destination)) {
      // A zero-length file is a previous run that died mid-copy.
      const info = await RNFS.stat(destination).catch(() => null);
      if (info && Number(info.size) > 0) {
        paths[name] = destination;
        continue;
      }
      await RNFS.unlink(destination).catch(() => {});
    }

    const partial = `${destination}.part`;
    await RNFS.unlink(partial).catch(() => {});

    if (Platform.OS === 'android') {
      // Reads from the APK's assets/, which is the only way in on Android.
      await RNFS.copyFileAssets(name, partial);
    } else {
      await RNFS.copyFile(`${RNFS.MainBundlePath}/${name}`, partial);
    }

    await RNFS.moveFile(partial, destination);
    paths[name] = destination;
  }

  return { graphPath: paths['road_graph.sqlite'], modelPath: paths['speed_model.tflite'] };
}
