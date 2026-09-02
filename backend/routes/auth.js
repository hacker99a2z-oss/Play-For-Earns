const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');

// Telegram Data Verification
function verifyTelegramData(telegramInitData, botToken) {
  const urlParams = new URLSearchParams(telegramInitData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckString = Array.from(urlParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return calculatedHash === hash;
}

// Login/Register Route
router.post('/login', async (req, res) => {
  try {
    const { initData, startParam } = req.body;
    
    // Auth Validation
    const isValid = verifyTelegramData(initData, process.env.BOT_TOKEN);
    if (!isValid) {
      return res.status(403).json({ error: 'Unauthorized Telegram Access!' });
    }

    const urlParams = new URLSearchParams(initData);
    const tgUser = JSON.parse(urlParams.get('user'));
    const stringUserId = tgUser.id.toString();

    // 🟢 ফিক্স: telegramId এর বদলে server.js এর সাথে মিলিয়ে userId ব্যবহার করা হলো
    let user = await User.findOne({ userId: stringUserId });

    if (!user) {
      user = new User({
        userId: stringUserId,
        firstName: tgUser.first_name || 'User',
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        photoUrl: tgUser.photo_url || '',
        referredBy: startParam || null
      });

      await user.save();

      // 🟢 ফিক্স: server.js এর নিয়মে রেফারার ইউজারের অ্যাকাউন্ট আপডেট করা
      if (startParam && String(startParam) !== stringUserId) {
        let referrerUser = await User.findOne({ userId: String(startParam) });
        if (referrerUser) {
          const alreadyExists = referrerUser.referrals.includes(user._id);
          if (!alreadyExists) {
            referrerUser.referralCount = (referrerUser.referralCount || 0) + 1;
            referrerUser.referrals.push(user._id);
            await referrerUser.save();
          }
        }
      }
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error("Login Route Error:", err);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Get Top Leaderboard API
router.get('/leaderboard', async (req, res) => {
  try {
    const topUsers = await User.find({})
      .sort({ dailyCoins: -1 })
      .limit(100)
      .select('firstName username photoUrl dailyCoins');

    res.json(topUsers);
  } catch (error) {
    res.status(500).json({ message: "Server Error" });
  }
});

module.exports = router;
