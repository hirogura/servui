#!/bin/bash
set -e

# --- yes/noプロンプト関数 ---
ask_yn() {
    local prompt="$1"
    local answer
    while true; do
        read -rp "$prompt [y/n]: " answer
        case "$answer" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo "y か n で答えてください。" ;;
        esac
    done
}

sudo apt update

# console-setup / keyboard-configuration のdebconf質問を事前回答で回避
sudo debconf-set-selections <<'EOF'
console-setup console-setup/codeset47 select Guess optimal character set
console-setup console-setup/fontface47 select Fixed
console-setup console-setup/fontsize select 16
keyboard-configuration keyboard-configuration/layout select Japanese
keyboard-configuration keyboard-configuration/layoutcode string jp
keyboard-configuration keyboard-configuration/variant select Japanese
EOF

sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y
sudo apt install -y curl
curl -fsSL https://tailscale.com/install.sh | sh

echo ""
if ask_yn "Tailscale の authkey がありますか？"; then
    read -rsp "authkey を入力してください（tskeyから始まる文字列。入力は非表示）: " TS_AUTHKEY
    echo ""
    USE_TS_AUTHKEY=true
else
    USE_TS_AUTHKEY=false
fi
echo ""

if [ "$USE_TS_AUTHKEY" = true ]; then
    sudo tailscale up --authkey="$TS_AUTHKEY"
else
    echo "[info] authkey未入力のためブラウザ認証フローを開始します"
    sudo tailscale up
fi

sudo apt install -y git
sudo git clone https://github.com/hirogura/servui.git
cd servui
sudo bash setup.sh
