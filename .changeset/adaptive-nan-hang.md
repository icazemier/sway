---
'@icazemier/sway': patch
---

Fix a hang when tasks complete in 0ms. A zero latency baseline and a zero EMA made the controller's gradient `0/0`, and the resulting `NaN` survived clamping and closed the scheduler's concurrency gate permanently, so the returned promise never settled.
