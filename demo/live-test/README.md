# Live smoke test

Proves MC Ship against a real Marketing Cloud BU using three throwaway assets,
all named `MCShip_Test_*`. Nothing else in the account is touched.

Assumes the BU is connected as `RS` (`agentia mc connect RS ...`) in your project folder.

```powershell
# 1. Put the test release in the project as source "SRC"
Copy-Item -Recurse <path-to>\mc-ship\demo\live-test\SRC mc\SRC

# 2. Target = only the test assets in the live BU (none exist yet)
agentia mc pull --bu RS --only MCShip_Test --no-row-counts
agentia mc diff SRC RS          # 3 added
agentia mc check SRC RS         # PASS
agentia mc deploy SRC RS --only MCShip_Test --dry-run
agentia mc deploy SRC RS --only MCShip_Test   # creates the DE, block and email

# 3. Change it and deploy again (update path)
node <path-to>\mc-ship\demo\live-test\step2.mjs
agentia mc diff SRC RS          # DE +ExpiryDate, email changed
agentia mc deploy SRC RS --only MCShip_Test

# 4. Confirm
agentia mc pull --bu RS --only MCShip_Test
agentia mc diff SRC RS          # 0 differences
```

`--only MCShip_Test` keeps the target refresh to the test assets, so deploy is fast and never reads the rest of the BU.
Clean up afterwards by deleting the three `MCShip_Test_*` assets in Marketing Cloud.
