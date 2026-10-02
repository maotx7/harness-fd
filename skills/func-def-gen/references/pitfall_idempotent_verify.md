#!/usr/bin/env python
"""校验脚本幂等性缺陷修复：
主循环按行幂等（row_has_bot_comment 跳过），终态核对若不含同口径排除，
会在重跑时把"上批已改值+挂批注"的行误判为漏改导致误回滚。
本次 ICC(8295) 车辆控制任务实锤：SmtEntryFctSts/SwtBackBriLeSet 上批挂了批注但值未改成（批注先于值写），
终态核对不带幂等排除 → 永久阻塞。修复：核对范围排除已挂bot批注的行（与主循环同口径），
历史"挂了批注没改成"的行由独立核查覆盖（audit_comments.py），不靠终态核对阻塞。
"""
print('documented')
