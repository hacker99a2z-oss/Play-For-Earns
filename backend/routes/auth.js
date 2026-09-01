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

    let user = await User.findOne({ telegramId: tgUser.id.toString() });

    if (!user) {
      user = new User({
        telegramId: tgUser.id.toString(),
        firstName: tgUser.first_name || 'User',
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        photoUrl: tgUser.photo_url || '',
        referredBy: startParam || null
      });

      if (startParam && startParam !== tgUser.id.toString()) {
        await User.findOneAndUpdate(
          { telegramId: startParam },
          { $inc: { referralCount: 1 } }
        );
      }

      await user.save();
    }

    res.json({ success: true, user });
  } catch (err) {
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
