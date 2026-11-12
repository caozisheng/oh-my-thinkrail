#!/usr/bin/env bash
set -euo pipefail

root="${1:-/etc/apt}"
while IFS= read -r -d '' file; do
	sed -i \
		-e 's|mirror+file:/etc/apt/apt-mirrors.txt|https://archive.ubuntu.com/ubuntu|g' \
		-e 's|mirror+file:/etc/apt/apt-security-mirrors.txt|https://security.ubuntu.com/ubuntu|g' \
		-e 's|https\?://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
		"$file"
done < <(find "$root" -type f \( -name '*.list' -o -name '*.sources' -o -name '*mirrors.txt' \) -print0)
