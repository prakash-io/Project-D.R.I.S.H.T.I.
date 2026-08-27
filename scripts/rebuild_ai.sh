#!/usr/bin/env bash
#
# Rebuild the incident vision model locally (ML-05).
#
#     bash scripts/rebuild_ai.sh
#
# `data/` is gitignored, so a fresh clone has the code but neither the 1,467
# NORMAL_TERRAIN photographs nor the trained `.pt`. This fetches the first and
# produces the second. Everything it runs is an existing script with its
# documented flags; this file is the ORDER and the guardrails, not new logic.
#
# Options:
#     --refetch          re-download the negatives even if enough are present
#     --epochs N         override the 40-epoch default
#     --count N          override the 1,467 negatives
#     --device mps|cpu|0 force a device (default: auto)
#
# Roughly 10-20 minutes on an M-series laptop: a few minutes to fetch, the
# rest training.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `data/` and `ai-services/.venv` are gitignored, so a git worktree gets the
# code and the directory skeleton but neither the 104 MB of images nor the
# environment -- and duplicating a multi-gigabyte dataset per worktree would be
# worse than the inconvenience it solves. DRISHTI_DATA_ROOT points this script
# at the checkout that HAS them:
#
#     DRISHTI_DATA_ROOT=~/drishti bash scripts/rebuild_ai.sh
#
# Defaults to this checkout, which is the right answer outside a worktree.
DATA_ROOT="${DRISHTI_DATA_ROOT:-${ROOT}}"
PY="${DRISHTI_VENV_PYTHON:-${DATA_ROOT}/ai-services/.venv/bin/python}"

NEG_DIR="${DATA_ROOT}/data/raw/vision/normal_terrain"
SRC_DIR="${DATA_ROOT}/data/raw/vision/incident-yolo"
OUT_PT="${DATA_ROOT}/data/artifacts/vision/incident-yolov8n.pt"

# 1,467 is not a round number and is not arbitrary: it is the negative pool the
# shipped model was trained against, and it balances the 571 landslide + 394
# flood training images so no class dominates the softmax.
COUNT=1467
EPOCHS=40
DEVICE=""
REFETCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --refetch) REFETCH=1; shift ;;
    --epochs)  EPOCHS="$2"; shift 2 ;;
    --count)   COUNT="$2"; shift 2 ;;
    --device)  DEVICE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
say "preflight"

[ -x "${PY}" ] || die "no venv at ${PY}
  create it:  cd ai-services && python3.12 -m venv .venv \\
                && .venv/bin/pip install -r requirements.txt"

"${PY}" - <<'EOF' || die "the venv is missing training dependencies (ultralytics, torch)"
# `import importlib` alone does NOT bind importlib.util -- it is a submodule,
# and reaching for it raises AttributeError, which this script would then
# report as "missing training dependencies" on a perfectly good venv.
import importlib.util
import sys
missing = [m for m in ("ultralytics", "torch", "PIL") if not importlib.util.find_spec(m)]
if missing:
    print("missing:", ", ".join(missing), file=sys.stderr)
    sys.exit(1)
print("  ultralytics, torch, pillow present")
EOF

# The hazard photographs themselves are NOT fetchable -- they are the
# `05_vision_hazard_detection_yolo` dataset and have to be restored by hand.
# Failing here with the layout spelled out beats failing 200 lines into the
# training script with a bare path.
[ -d "${SRC_DIR}/train/images" ] || die "no source dataset at ${SRC_DIR}
  Expected layout (the 05_vision_hazard_detection_yolo dataset):
      data/raw/vision/incident-yolo/{train,val,test}/images/*.jpg
      data/raw/vision/incident-yolo/{train,val,test}/labels/*.txt
  Restore it from your dataset archive; this script cannot download it."

n_src=$(find "${SRC_DIR}" -path '*/images/*' \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) | wc -l | tr -d ' ')
echo "  source hazard images: ${n_src}"

# ------------------------------------------------------- REVIEW GUARDRAIL
# This is the reason this script asserts rather than merely trains.
#
# Both HAZARD classes in the training set are satellite and aerial imagery. A
# driver's photograph is taken from the road, at ground level, on a phone --
# out of distribution for the classes it is being asked to recognise. The
# model can now say "nothing here" (NORMAL_TERRAIN is real and
# content-derived), but being able to say nothing-is-wrong is a DIFFERENT
# capability from recognising that something is.
#
# So a confident verdict from this model is not evidence enough to close a
# road. Two flags keep a dispatcher in the loop, and retraining must never be
# the moment they quietly get flipped:
#
#     INCIDENT_REQUIRE_REVIEW=1   every verdict carries requires_human_review
#     AUTO_BLOCK_ON_AI_VERDICT=0  no verdict alone sets an edge cost to 999999
#
# Only a `verified` incident blocks an edge, and only a dispatcher's approval
# in WEB-05 produces that status.
say "review guardrails"

check_flag() {   # name expected actual where
  if [ "$3" = "$2" ]; then
    echo "  ok   $1=$3  ($4)"
  else
    die "$1 is '$3', must be '$2'  ($4)

  Both hazard classes are satellite/aerial imagery, so this model is out of
  distribution on the ground-level photographs it actually receives. It may
  not close a road on its own. See CLAUDE.md decisions 4 and 5."
  fi
}

# The environment wins over the file, so check whichever will actually apply.
env_file="${DATA_ROOT}/.env"
from_file() { [ -f "${env_file}" ] && grep -E "^$1=" "${env_file}" | tail -1 | cut -d= -f2- || true; }

review="${INCIDENT_REQUIRE_REVIEW:-$(from_file INCIDENT_REQUIRE_REVIEW)}"
autoblock="${AUTO_BLOCK_ON_AI_VERDICT:-$(from_file AUTO_BLOCK_ON_AI_VERDICT)}"
# Unset anywhere means the code default, which is 1 and 0 respectively.
check_flag INCIDENT_REQUIRE_REVIEW  1 "${review:-1}"     "code default 1"
check_flag AUTO_BLOCK_ON_AI_VERDICT 0 "${autoblock:-0}"  "code default 0"

# ------------------------------------------------------------- negatives
say "NORMAL_TERRAIN negatives"

have=0
if [ -d "${NEG_DIR}" ]; then
  have=$(find "${NEG_DIR}" -maxdepth 1 \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' \) | wc -l | tr -d ' ')
fi
echo "  present: ${have} / ${COUNT}"

if [ "${REFETCH}" = "1" ] || [ "${have}" -lt "${COUNT}" ]; then
  # Needs the network. The seed prefix is deterministic, so re-running fetches
  # the SAME photographs rather than a fresh random set -- which is what keeps
  # the train/val/test split stable across rebuilds.
  # --dir passed explicitly: fetch_normal_terrain.py derives its own ROOT from
  # its own location, which is the wrong checkout whenever DRISHTI_DATA_ROOT
  # points elsewhere.
  "${PY}" "${ROOT}/scripts/fetch_normal_terrain.py" \
      --count "${COUNT}" --dir "${NEG_DIR}"
else
  echo "  enough already present; pass --refetch to download again"
fi

# ---------------------------------------------------------------- training
say "training yolov8n-cls, ${EPOCHS} epochs"

# Every path explicit, for the same reason as the fetch above.
train_args=(
  --epochs "${EPOCHS}"
  --src "${SRC_DIR}"
  --negatives "${NEG_DIR}"
  --cls-dir "${DATA_ROOT}/data/processed/vision/incident-cls"
  --out "${OUT_PT}"
)
[ -n "${DEVICE}" ] && train_args+=(--device "${DEVICE}")

# --label-source defaults to `pool`, which is what you want and why:
# NORMAL_TERRAIN and DAMAGED_BRIDGE_INFRASTRUCTURE as shipped in the dataset's
# own label files are assigned by filename index arithmetic, not by image
# content (verified across all 1,380 labels). `pool` takes the class from the
# image pool instead, which is the only content-derived signal that survives
# inspection. Passing `--label-source file` reproduces the original run, in
# which ~28% of images carry a label uncorrelated with what they show.
"${PY}" "${ROOT}/scripts/train_incident_yolo.py" "${train_args[@]}"

# ----------------------------------------------------------------- verify
say "verify"

[ -f "${OUT_PT}" ] || die "training finished but ${OUT_PT} is missing"
ls -lh "${OUT_PT}" | awk '{print "  weights: " $9 " (" $5 ")"}'

if [ -f "${DATA_ROOT}/data/artifacts/vision/incident-yolov8n_meta.json" ]; then
  "${PY}" - <<EOF
import json, pathlib
meta = json.loads(pathlib.Path("${DATA_ROOT}/data/artifacts/vision/incident-yolov8n_meta.json").read_text())

# In MODEL INDEX order, not the data.yaml order. The two can differ, the meta
# records both for exactly that reason, and printing the wrong one would
# mislabel every probability the service reports.
classes = meta.get("classes_model_index_order", [])
print("  classes:", ", ".join(classes) if classes else "(none recorded)")
print("  epochs: ", meta.get("epochs"))

test = meta.get("test", {})
if "top1" in test:
    print(f"  top-1:   {test['top1']:.4f}")
for name, row in (test.get("per_class") or {}).items():
    print(f"    {name:<34} n={row['n']:>4}  recall={row['recall']:.4f}")

# The safe class has to be REAL for the model to be able to say "no hazard
# here". If it is absent the model is two-class again, every softmax sums to 1
# over two hazards, and every photograph on earth becomes a flood or a
# landslide -- the exact failure CLAUDE.md decision 4 records.
if "NORMAL_TERRAIN" not in classes:
    raise SystemExit("  error: NORMAL_TERRAIN missing -- the model cannot "
                     "answer 'no hazard here'. Do not ship this.")
EOF
fi

say "done"
cat <<'EOF'
  The AI service loads these weights at startup:

      cd ai-services && .venv/bin/python -m uvicorn main:app --port 8000

  Then confirm the guardrail survived the rebuild -- a verdict must still ask
  for a human:

      curl -s localhost:8000/health | python3 -m json.tool
      curl -s localhost:4000/health | python3 -m json.tool   # auto_block false

  And run the suite:

      ai-services/.venv/bin/python -m pytest ai-services/tests -q
EOF

# =============================================================================
# WHERE TO DROP REAL GROUND-LEVEL NER PHOTOGRAPHS
# =============================================================================
#
# This is the open blind spot, and closing it needs photographs rather than
# code. Both hazard classes are currently satellite and aerial imagery, so a
# driver's ground-level photograph of a genuine landslide is out of
# distribution for the class meant to recognise it.
#
# You need a few hundred per hazard class. Put them here:
#
#     data/raw/vision/incident-yolo/train/images/
#     data/raw/vision/incident-yolo/val/images/
#     data/raw/vision/incident-yolo/test/images/
#
# NAME THEM BY THEIR CLASS PREFIX. In the default `pool` label source the
# class is read from the filename, by `pool_of()` in train_incident_yolo.py,
# which takes everything before the first underscore:
#
#     landslide_ner_0001.jpg   ->  ACTIVE_LANDSLIDE_DEBRIS
#     flood_ner_0001.jpg       ->  FLOODED_ROAD_OR_SUBMERGED
#
# Any other prefix is SKIPPED with "filename has no known pool prefix" -- it is
# not misfiled, it is silently absent from training, so check the skip count
# the script prints. No label .txt is needed in `pool` mode; the prefix is the
# label. This is the "no code change" path.
#
# Split them yourself across train/val/test at roughly 70/15/15. Put photos of
# the SAME incident in the SAME split -- twenty angles of one landslide spread
# across train and test will report an accuracy the model has not earned.
#
# Ordinary ground-level road photographs that show NO hazard go somewhere
# different, because that class is a flat pool with its own hashed split:
#
#     data/raw/vision/normal_terrain/
#
# Then re-run this script. Expect the headline accuracy to FALL: the current
# number is measured on satellite tiles that are easy to separate, and a real
# ground-level test set is a harder and more honest question.
#
# What does NOT change: INCIDENT_REQUIRE_REVIEW stays 1 and
# AUTO_BLOCK_ON_AI_VERDICT stays 0 until a held-out set of real ground-level
# photographs says otherwise. Adding images is not evidence; measuring on them
# is. The assertions above will stop this script if either is flipped.
# =============================================================================
