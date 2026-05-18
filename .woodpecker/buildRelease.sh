#!/bin/bash

pnpm run build 2>&1 | tee build.log
build_status=${PIPESTATUS[0]}

if [ $build_status -ne 0 ]; then
  echo "Build failed. Exiting with status code $build_status"
  exit $build_status
fi
