---
description: 把本次对话的结论记到个人日志
---
把本次会话中值得长期保留的内容整理成一条笔记：开头一句话说结论，然后是关键要点、命令或代码、还没解决的问题。不超过 15 行，不要寒暄。
$ARGUMENTS

然后用 Bash 执行下面的命令（用 heredoc 传入，避免引号问题）：

NOTE_SOURCE=claude-code note -t AI对话 <<'EOF'
<整理好的内容>
EOF
