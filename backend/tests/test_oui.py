import time

from backend import oui

CSV = (
    "Registry,Assignment,Organization Name,Organization Address\n"
    'MA-L,B827EB,Raspberry Pi Foundation,"Mitchell Wood House"\n'
    "MA-L,F09FC2,Ubiquiti Inc,Somewhere\n"
)


def loaded(monkeypatch):
    monkeypatch.setattr(oui, "_table", oui._parse(CSV))


def test_known_prefix_any_separator_or_case(monkeypatch):
    loaded(monkeypatch)
    for mac in ("b8:27:eb:12:34:56", "B8-27-EB-12-34-56", "b827eb123456"):
        assert oui.describe(mac) == {"vendor": "Raspberry Pi Foundation", "randomized": False}


def test_randomized_addresses_are_named_as_such(monkeypatch):
    loaded(monkeypatch)
    # Second hex digit 2, 6, A or E = locally administered (phones do this).
    for mac in ("3a:22:fb:7c:31:31", "d2:ad:be:ef:77:77", "fe:00:00:00:00:00"):
        assert oui.describe(mac) == {"vendor": None, "randomized": True}


def test_unknown_missing_and_short(monkeypatch):
    loaded(monkeypatch)
    assert oui.describe("00:11:22:33:44:55")["vendor"] is None
    assert oui.describe(None) == {"vendor": None, "randomized": False}
    assert oui.describe("ab:cd") == {"vendor": None, "randomized": False}


def test_answers_unknown_straight_away_while_the_list_loads(monkeypatch, tmp_path):
    monkeypatch.setattr(oui, "_table", None)
    monkeypatch.setattr(oui, "_loading", False)
    monkeypatch.setattr(oui, "OUI_FILE", str(tmp_path / "oui.csv"))
    (tmp_path / "oui.csv").write_text(CSV)  # fresh: no download
    first = oui.describe("b8:27:eb:00:00:01")
    assert first["vendor"] is None or first["vendor"] == "Raspberry Pi Foundation"
    for _ in range(50):
        if oui._table is not None:
            break
        time.sleep(0.05)
    assert oui.describe("b8:27:eb:00:00:01")["vendor"] == "Raspberry Pi Foundation"


def test_annotate_adds_both_fields(monkeypatch):
    loaded(monkeypatch)
    devices = [{"ip": "1", "mac": "f0:9f:c2:00:00:01"}, {"ip": "2", "mac": None}]
    out = oui.annotate(devices)
    assert out[0]["vendor"] == "Ubiquiti Inc" and out[1]["vendor"] is None
