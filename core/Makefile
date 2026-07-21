# spooftun core build
#
#   make            -> native binary (./spooftun) for the current host arch
#   make all        -> cross-build amd64 + arm64 into ../bin
#   make amd64      -> ../bin/spooftun-amd64   (needs gcc-x86-64-linux-gnu)
#   make arm64      -> ../bin/spooftun-arm64   (needs gcc-aarch64-linux-gnu)
#   make install    -> build native + copy to /usr/local/bin/spooftun
#   make clean

CC        ?= gcc
CFLAGS    ?= -O2 -Wall -Wextra -pthread -static
SRC        = spooftun.c
OUT_DIR    = ../bin

AMD64_CC   = x86_64-linux-gnu-gcc
ARM64_CC   = aarch64-linux-gnu-gcc

.PHONY: all native amd64 arm64 install clean

native: $(SRC)
	$(CC) $(CFLAGS) -o ./spooftun $(SRC)
	@echo "Built native binary: ./spooftun"

all: amd64 arm64

amd64: $(SRC)
	@mkdir -p $(OUT_DIR)
	@if command -v $(AMD64_CC) >/dev/null 2>&1; then \
		$(AMD64_CC) $(CFLAGS) -o $(OUT_DIR)/spooftun-amd64 $(SRC) && \
		echo "Built amd64 binary: $(OUT_DIR)/spooftun-amd64"; \
	elif [ "$$(uname -m)" = "x86_64" ]; then \
		$(CC) $(CFLAGS) -o $(OUT_DIR)/spooftun-amd64 $(SRC) && \
		echo "Built amd64 binary (native): $(OUT_DIR)/spooftun-amd64"; \
	else \
		echo "Skip amd64: install gcc-x86-64-linux-gnu"; \
	fi

arm64: $(SRC)
	@mkdir -p $(OUT_DIR)
	@if command -v $(ARM64_CC) >/dev/null 2>&1; then \
		$(ARM64_CC) $(CFLAGS) -o $(OUT_DIR)/spooftun-arm64 $(SRC) && \
		echo "Built arm64 binary: $(OUT_DIR)/spooftun-arm64"; \
	elif [ "$$(uname -m)" = "aarch64" ]; then \
		$(CC) $(CFLAGS) -o $(OUT_DIR)/spooftun-arm64 $(SRC) && \
		echo "Built arm64 binary (native): $(OUT_DIR)/spooftun-arm64"; \
	else \
		echo "Skip arm64: install gcc-aarch64-linux-gnu"; \
	fi

install: native
	install -m 0755 ./spooftun /usr/local/bin/spooftun
	@echo "Installed /usr/local/bin/spooftun"

clean:
	rm -f ./spooftun $(OUT_DIR)/spooftun-amd64 $(OUT_DIR)/spooftun-arm64
