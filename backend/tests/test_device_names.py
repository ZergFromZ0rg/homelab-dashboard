from backend import device_names as dn


def g(**d):
    return (dn.guess(d) or {}).get("kind")


def test_hostname_wins():
    assert g(hostname="Boris-iPhone.lan", vendor="Apple, Inc.") == "iPhone"
    assert g(hostname="Galaxy-S21", ports=[]) == "Android phone"
    assert g(hostname="HP-LaserJet-4100") == "Printer"


def test_ports_then_vendor_then_private():
    assert g(ports=[{"port": 9100, "service": "printer"}], vendor="Hewlett Packard") == "Printer"
    assert g(ports=[{"port": 62078, "service": "ios"}], vendor="Apple, Inc.") == "iPhone or iPad"
    assert g(vendor="Apple, Inc.") == "Apple device"
    assert g(vendor="Espressif Inc.") == "Smart device"
    assert g(randomized=True) == "Phone or laptop"
    assert g(vendor="Nobody Ltd") is None


def test_store_roundtrip_and_clear(tmp_path):
    store = dn.NameStore(tmp_path / "n.json")
    assert store.set("AA:BB:CC:00:00:01", "  Dad's iPad ") == {"aa:bb:cc:00:00:01": "Dad's iPad"}
    assert dn.NameStore(tmp_path / "n.json").all() == {"aa:bb:cc:00:00:01": "Dad's iPad"}
    assert store.set("aa:bb:cc:00:00:01", "") == {}
