---
description: Refresh the Pragma menu — each item's status and title, read again from Pragma
disable-model-invocation: true
---

The pragma plugin's hooks answer `/pragma:refresh` themselves; this text reaches you only when they did not load. Tell the user in one line that the Pragma menu could not be refreshed because the plugin's hooks are not loaded, and that `claude plugin validate` on the plugin folder says why. Do nothing else.
