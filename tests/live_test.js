const BASE_URL = 'https://igslbackend.onrender.com';

async function runLiveTests() {
  console.log(`Starting live API tests against: ${BASE_URL}\n`);
  
  let adminToken;
  let brokerToken;
  let companyId;
  let brokerId;
  let tripObjectId;

  // Generate unique randomized data to avoid database constraint conflicts
  const uniqueId = Math.floor(100000 + Math.random() * 900000); // 6 digits
  const brokerPhone = `98${uniqueId}99`; // 10 digits

  const companyPan = `AAFCC${uniqueId.toString().substring(0, 4)}R`;
  const companyGstin = `29${companyPan}1Z1`;

  const brokerPan = `BQRPB${uniqueId.toString().substring(0, 4)}A`;
  const brokerDl = `KA042018${uniqueId}`;
  const brokerVehicle = `KA04AB${uniqueId.toString().substring(2, 6)}`;
  const brokerAccount = `9988${uniqueId}5544`;
  const brokerUpi = `suresh_${uniqueId}@ybl`;

  console.log(`Generated Test Parameters:`);
  console.log(`- Broker Phone: ${brokerPhone}`);
  console.log(`- Company GSTIN: ${companyGstin}`);
  console.log(`- Broker Vehicle: ${brokerVehicle}\n`);

  // Helper to log test status
  const testStep = async (name, fn) => {
    try {
      console.log(`⏳ Testing: ${name}...`);
      const start = Date.now();
      await fn();
      console.log(`✅ Success: ${name} (${Date.now() - start}ms)\n`);
    } catch (err) {
      console.error(`❌ Failed: ${name}`);
      console.error(err.message || err);
      process.exit(1);
    }
  };

  // 1. Send OTP for Admin
  await testStep('POST /api/auth/otp/send (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: '9900000000' })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 2. Verify OTP for Admin
  await testStep('POST /api/auth/otp/verify (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: '9900000000',
        otp: '123456',
        role: 'admin',
        name: 'Super Admin'
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    adminToken = data.data.token;
  });

  // 3. Send OTP for Broker
  await testStep('POST /api/auth/otp/send (Broker)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: brokerPhone })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 4. Verify OTP for Broker
  await testStep('POST /api/auth/otp/verify (Broker)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: brokerPhone,
        otp: '123456',
        role: 'broker',
        name: 'Suresh Transport'
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    brokerToken = data.data.token;
  });

  // 5. Onboard Company
  await testStep('POST /api/onboarding/company (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/onboarding/company`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        name: `JSW Steel Live Test ${uniqueId}`,
        gstin: companyGstin,
        pan_number: companyPan,
        billing_address: {
          line1: 'Vidyanagar',
          city: 'Toranagallu',
          state: 'Karnataka',
          pincode: '583123'
        },
        locations: [
          { name: 'Loading Gate 1', lat: 15.2012, lng: 76.6214 }
        ],
        rate_config: {
          type: 'per_mt_per_km',
          base_rate: 4.5
        }
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    companyId = data.data.company._id;
  });

  // 6. Onboard Broker
  await testStep('POST /api/onboarding/broker (Broker)', async () => {
    const res = await fetch(`${BASE_URL}/api/onboarding/broker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${brokerToken}`
      },
      body: JSON.stringify({
        name: 'Suresh Transport Services',
        pan_number: brokerPan,
        dl_number: brokerDl,
        rc_details: {
          vehicle_number: brokerVehicle,
          vehicle_type: 'trailer',
          rc_expiry: '2030-01-01'
        },
        payment_details: {
          bank_account: brokerAccount,
          ifsc: 'SBIN0001002',
          upi_id: brokerUpi
        }
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    brokerId = data.data.broker._id;
  });

  // 7. Create Trip
  await testStep('POST /api/trips (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/trips`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        company_id: companyId,
        material: 'HR Steel Coils',
        weight_mt: 25.5,
        source: {
          name: 'JSW Janki Plant',
          lat: 15.2012,
          lng: 76.6214,
          address: 'Toranagallu, Bellary'
        },
        destination: {
          name: 'IQSL Chennai Yard',
          lat: 13.0827,
          lng: 80.2707,
          address: 'Ennore Port Road, Chennai'
        },
        distance_km: 550
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
    tripObjectId = data.data.trip._id;
  });

  // 8. Assign Broker
  await testStep('POST /api/trips/:id/assign (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/trips/${tripObjectId}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ broker_id: brokerId })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 9. Dispatch Trip
  await testStep('POST /api/trips/:id/dispatch (Broker)', async () => {
    const res = await fetch(`${BASE_URL}/api/trips/${tripObjectId}/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${brokerToken}`
      },
      body: JSON.stringify({ ewaybill_number: '881234567890' })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 10. Initiate Advance Payment
  await testStep('POST /api/payments/:trip_id/advance/initiate (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${tripObjectId}/advance/initiate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 11. Verify Advance Payment
  await testStep('POST /api/payments/:trip_id/advance/verify (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${tripObjectId}/advance/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        payment_id: `pay_${uniqueId}XYZ`,
        signature: 'mock_signature_approved'
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 12. Track Trip
  await testStep('POST /api/trips/:id/track (Broker)', async () => {
    const res = await fetch(`${BASE_URL}/api/trips/${tripObjectId}/track`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${brokerToken}`
      }
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 13. Upload POD (Broker)
  await testStep('POST /api/trips/:id/pod (Broker - Multi-part file upload)', async () => {
    const formData = new FormData();
    const mockImage = new Blob(['fake-image-binary-data'], { type: 'image/png' });
    formData.append('pod', mockImage, 'pod_receipt.png');

    const res = await fetch(`${BASE_URL}/api/trips/${tripObjectId}/pod`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${brokerToken}`
      },
      body: formData
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 14. Approve POD (Admin)
  await testStep('POST /api/trips/:id/pod/approve (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/trips/${tripObjectId}/pod/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 15. Settle Trip Payment
  await testStep('POST /api/payments/:trip_id/settle (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${tripObjectId}/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        shortage_mt: 0.5,
        shortage_amount: 2500,
        damage_amount: 0,
        delay_penalty: 1000
      })
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 16. Admin Dashboard Metrics
  await testStep('GET /api/admin/dashboard/metrics (Admin)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/dashboard/metrics`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    });
    const data = await res.json();
    if (res.status !== 200 || !data.success) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  console.log('🎉 ALL LIVE ENDPOINTS TESTED SUCCESSFULLY AND WORKING PERFECTLY!');
}

runLiveTests();
