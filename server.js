import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import valid from 'card-validator';
import crypto from 'crypto';

// Initialize environment variables
dotenv.config();

// Get current file path in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Middleware for most endpoints
app.use(cors());
app.use(bodyParser.json());

// Debug middleware to log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Helper function for Luhn algorithm check
function luhnCheck(cardNumber) {
  let sum = 0;
  let shouldDouble = false;
  const strippedNumber = cardNumber.replace(/\s+/g, '');
  
  for (let i = strippedNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(strippedNumber.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return (sum % 10) === 0;
}

// Determine Peach Payments API endpoint based on environment
const peachEndpoint = process.env.NODE_ENV !== 'production'
  ? 'https://testsecure.peachpayments.com/v2/checkout'
  : 'https://secure.peachpayments.com/v2/checkout'; // See: https://developer.peachpayments.com/docs/reference-test-and-go-live

// Checkout endpoint for processing payments
app.post('/api/checkout', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Checkout payload:', JSON.stringify(payload));
    
    // Ensure required fields are provided per Peach Payments docs
    if (!payload.authentication?.entityId ||
        !payload.merchantTransactionId ||
        !payload.amount ||
        !payload.currency ||
        !payload.nonce ||
        !payload.shopperResultUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields', 
        details: 'Please provide all required fields for Peach Payments' 
      });
    }

    // Validate card details if provided
    if (payload.card && payload.card.number) {
      const cardNumber = payload.card.number.replace(/\s+/g, '');
      const numberValidation = valid.number(cardNumber);
      if (!numberValidation.isPotentiallyValid) {
        return res.status(400).json({
          error: 'Invalid card format',
          details: 'The card number format is not valid'
        });
      }
      if (!numberValidation.isValid) {
        return res.status(400).json({
          error: 'Card validation failed',
          details: 'The provided card number failed validation checks'
        });
      }
      // Check length based on card type
      if ((numberValidation.card.type === 'visa' ||
           numberValidation.card.type === 'mastercard' ||
           numberValidation.card.type === 'discover') && cardNumber.length !== 16) {
        return res.status(400).json({
          error: 'Invalid card length',
          details: `${numberValidation.card.type} cards must be 16 digits`
        });
      }
      if (numberValidation.card.type === 'american-express' && cardNumber.length !== 15) {
        return res.status(400).json({
          error: 'Invalid card length',
          details: 'American Express cards must be 15 digits'
        });
      }
      // Perform Luhn check
      if (!luhnCheck(cardNumber)) {
        return res.status(400).json({
          error: 'Invalid card number',
          details: 'The card number failed the Luhn algorithm check'
        });
      }
    }

    // Test simulation logic for non-production environments
    if (process.env.NODE_ENV !== 'production') {
      const failingCardNumbers = ['4012001037461114', '4012001037141112', '4532497088771651'];
      const declinedCardNumbers = ['4000000000000002', '5555555555554444'];
      const expiredCardNumbers = ['4000000000000069', '5105105105105100'];
      const insufficientFundsCards = ['4000000000009995', '5555555555554477'];
      
      if (payload.card && payload.card.number) {
        const cleanCardNumber = payload.card.number.replace(/\s+/g, '');
        if (failingCardNumbers.includes(cleanCardNumber)) {
          return res.status(400).json({
            error: 'Simulated payment failure',
            details: 'This test card is designed to simulate a generic error response',
            code: 'ERROR'
          });
        }
        if (declinedCardNumbers.includes(cleanCardNumber)) {
          return res.status(400).json({
            error: 'Payment declined',
            details: 'This test card is designed to simulate a declined payment',
            code: 'DECLINED'
          });
        }
        if (expiredCardNumbers.includes(cleanCardNumber)) {
          return res.status(400).json({
            error: 'Card expired',
            details: 'This test card is designed to simulate an expired card',
            code: 'EXPIRED'
          });
        }
        if (insufficientFundsCards.includes(cleanCardNumber)) {
          return res.status(400).json({
            error: 'Insufficient funds',
            details: 'This test card is designed to simulate insufficient funds',
            code: 'INSUFFICIENT_FUNDS'
          });
        }
      }
      
      if (payload.amount) {
        switch (parseFloat(payload.amount)) {
          case 92.00:
            return res.status(200).json({
              checkoutId: 'test-success-' + Date.now(),
              amount: payload.amount * 100,
              status: 'SUCCESS',
              message: 'Test payment processed successfully'
            });
          case 15.99:
            return res.status(200).json({
              checkoutId: 'test-pending-' + Date.now(),
              amount: payload.amount * 100,
              status: 'PENDING',
              message: 'Payment is being processed'
            });
          case 0.01:
            return res.status(400).json({
              error: 'Amount too small',
              details: 'The payment amount is below the minimum threshold',
              code: 'INVALID_AMOUNT'
            });
        }
      }
      
      // Default test success response
      return res.status(200).json({
        checkoutId: 'mock-checkout-' + Date.now(),
        amount: payload.amount * 100,
        status: 'SUCCESS',
        message: 'Test payment processed successfully'
      });
    }

    // In production, send the checkout request to Peach Payments API
    const peachResponse = await fetch(peachEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PEACH_PAYMENTS_API_KEY}`,
        'Accept': 'application/json',
        // The Referer must be whitelisted in your Peach Payments configuration
        'Referer': req.headers.referer || 'https://yourdomain.com'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await peachResponse.json();
    console.log('Peach Payments response:', JSON.stringify(responseData));

    if (!peachResponse.ok) {
      return res.status(peachResponse.status).json({
        error: responseData.message || 'Error from payment provider',
        details: responseData
      });
    }
    return res.status(200).json(responseData);
  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Webhook endpoint to handle notifications from Peach Payments
// Use raw body parser to capture the unparsed payload for signature verification
app.post('/api/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['peach-signature']; // Header name may differ per docs
  const webhookSecret = process.env.PEACH_WEBHOOK_SECRET;
  
  // Ensure signature header exists
  if (!signature) {
    console.error('Missing Peach-Signature header');
    return res.status(400).send('Missing signature header');
  }
  
  // Verify the webhook signature
  // Here we assume Peach Payments uses an HMAC with SHA256. Adjust according to the docs.
  const computedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.body)
    .digest('hex');
  
  if (computedSignature !== signature) {
    console.error('Invalid webhook signature');
    return res.status(401).send('Invalid signature');
  }
  
  // Parse the JSON payload now that signature is verified
  let eventData;
  try {
    eventData = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('Error parsing webhook JSON:', err);
    return res.status(400).send('Invalid JSON');
  }
  
  console.log('Received webhook event:', JSON.stringify(eventData));
  
  // Process the webhook event as needed. For example:
  // - Payment successful
  // - Payment failed
  // - Payment refunded
  // See https://developer.peachpayments.com/docs/reference-webhooks for details
  
  // Acknowledge receipt of the event
  res.status(200).send('Webhook received');
});

// Verification endpoint to simulate payment verification outcomes
app.post('/api/verify-payment', (req, res) => {
  const params = req.body;
  console.log('Verifying payment with params:', params);
  
  if (params.simulateStatus) {
    switch (params.simulateStatus) {
      case 'failed':
        return res.json({
          success: false,
          message: 'Payment verification failed',
          transactionId: params.id || 'mock-failed-transaction',
          status: 'FAILED'
        });
      case 'pending':
        return res.json({
          success: true,
          message: 'Payment is still processing',
          transactionId: params.id || 'mock-pending-transaction',
          status: 'PENDING',
          amount: params.amount || 9200
        });
      case 'refunded':
        return res.json({
          success: true,
          message: 'Payment was refunded',
          transactionId: params.id || 'mock-refunded-transaction',
          status: 'REFUNDED',
          amount: params.amount || 9200
        });
    }
  }
  
  // Default successful verification
  res.json({
    success: true,
    message: 'Payment verified successfully',
    transactionId: params.id || 'mock-transaction-id',
    status: 'SUCCESS',
    amount: params.amount || 9200
  });
});

// Start the API server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API Server running on port ${PORT}`);
});
