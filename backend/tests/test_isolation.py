"""The capture features keep state in module globals; the suite resets it after
every test (see the root conftest). Parametrized rounds run in order, so rounds 2
and 3 only pass if round 1's leftovers were really cleared — taking the fixture
away makes this fail, rather than some Overview test a few files later."""

import pytest

from backend import autocapture, capture_store, netwatch_api


@pytest.mark.parametrize("round_", [1, 2, 3])
def test_state_left_by_one_test_does_not_reach_the_next(round_, tmp_path):
    assert netwatch_api.latest() == []
    assert autocapture._busy == set() and autocapture._recent == {} and autocapture._last_for_check == {}
    assert not capture_store.DIR.exists()  # a fresh directory each time: last round's saved capture is not in it
    assert capture_store.DIR.parent == tmp_path and autocapture.FILE.parent == tmp_path  # never the real /data

    # ...and now make a mess, as a careless test would.
    netwatch_api._latest.append({"id": "x", "title": "t", "message": "m", "host": "box"})
    autocapture._busy.add("box")
    autocapture._recent["box"] = [1.0]
    autocapture._last_for_check["check:c1"] = 1.0
    capture_store.save("box", "leftover", {"packets": [{"n": 1}], "totals": {}})
