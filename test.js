let bundleId = crypto.randomUUID();
for (let i = 0; i < 20; i++) {
  fetch("http://localhost:2000", {
    method: "GET",
    headers: {
      "3suite-bundle-id": bundleId,
      "3suite-bundle-size": 20,
      "3suite-bundle-order": 20 - i
    }
  })
}

for (let i = 0; i < 10; i++) {
  fetch("http://localhost:2000", {
    method: "GET"
  })
}

for (let i = 0; i < 10; i++) {
  fetch("http://localhost:2000", {
    method: "GET",
    headers: {
      "3suite-priority": 10
    }
  })
}
