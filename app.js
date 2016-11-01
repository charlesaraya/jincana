'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const Messenger = require('fb-messenger-app').default
const botdata = require('./test/botdata.js') // import test bot data
const Wit = require('node-wit').Wit
const log = require('node-wit').log

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN  // Generate a page access token for your page from the App Dashboard
const VERIFY_TOKEN = process.env.APP_VERIFY_TOKEN // Arbitrary value used to validate a webhook
const APP_SECRET = process.env.APP_SECRET // App Secret can be retrieved from the App Dashboard
const WIT_TOKEN = process.env.WIT_TOKEN // Wit token can be retrieved from the Api details

if (!(APP_SECRET && VERIFY_TOKEN && PAGE_TOKEN && WIT_TOKEN)) {
  console.error('Missing config values')
  process.exit(1)
}

const app = express()

const messenger = new Messenger(PAGE_TOKEN, {
  notificationType: 'REGULAR' // just show off since REGULAR is default
})

app.set('port', process.env.PORT || 3000)
app.use(express.static('public'))

app.use(bodyParser.urlencoded({
  extended: false
}))

// bind app secret to verify the request signature
app.use(bodyParser.json({
  verify: messenger.verify.signature.bind(messenger, APP_SECRET)
}))

// ----------------------------------------------------------------------------
// Wit.ai bot specific code

// Each session has an entry: sessionId -> {fbid: facebookUserId, context: sessionState}
const sessions = {} // all user sessions.
const findOrCreateSession = function (fbid) {
  let sessionId
  // Check if there's a session for the user fbid
  Object.keys(sessions).forEach(function (k) {
    if (sessions[k].fbid === fbid) {
      sessionId = k
    }
  })
  // No session found for user fbid, let's create a new one
  if (!sessionId) {
    sessionId = new Date().toISOString()
    sessions[sessionId] = {fbid: fbid, context: {}}
  }
  return sessionId
}

const firstEntityValue = function (entities, entity) {
  const val = entities && entities[entity] && Array.isArray(entities[entity]) && entities[entity].length > 0 && entities[entity][0].value
  if (!val) {
    return null
  }
  return typeof val === 'object' ? val.value : val
}

// The bot's actions
const actions = {
  send: function send (request, response) {
    let sessionId = request.sessionId
    const recipientId = sessions[sessionId].fbid // Retrieve fb user session

    if (recipientId) {
      // Let's forward our bot response to her.
      // We return a promise to let our bot know when we're done sending
      return new Promise(function (resolve, reject) {
        console.log('user said...', JSON.stringify(request.text))
        console.log('sending...', JSON.stringify(response))
        messenger.sendApiMessage(recipientId, { text: `echo: ${response.text}` }, function (err) {
          if (err) {
            console.error('Error while fwding the response to', recipientId, ':', err.stack || err)
          }
        })
        return resolve()
      })
    } else {
      console.error('Oops! Couldn\'t find user for session:', sessionId)
      return Promise.resolve()  // Giving the wheel back to our bot
    }
  },
  // Quickstart example
  // See https://wit.ai/charlesaraya/jincana.forecast
  getForecast ({context, entities}) {
    return new Promise(function (resolve, reject) {
      var location = firstEntityValue(entities, 'location')
      if (location) {
        context.forecast = 'sunny in ' + location // we should call a weather API here
        delete context.missingLocation
      } else {
        context.missingLocation = true
        delete context.forecast
      }
      return resolve(context)
    })
  }
}

// Setting up our bot
const wit = new Wit({
  accessToken: WIT_TOKEN,
  actions,
  logger: new log.Logger(log.INFO)
})

// Webhook setup
app.get('/webhook', function (req, res) {
  return messenger.verify.webhook(VERIFY_TOKEN, req, res)
})

// handle upcoming callbacks to our webhook from facebook
app.post('/webhook', function (req, res) {
  let data = req.body
  // messenger._handleCallback(res, data)
  if (data.object === 'page') {
    data.entry.forEach(entry => {
      entry.messaging.forEach(event => {
        if (event.message && !event.message.is_echo) {
          const sender = event.sender.id
          // We retrieve the user's current session, or create one if it doesn't exist
          // This is needed for our bot to figure out the conversation history
          const sessionId = findOrCreateSession(sender)

          if (event.message && event.message.quick_reply) {
            messenger._handleEvent('quickReply', event)
          } else if (event.message && event.message.text) {
            // fwd the message to the Wit.ai Bot Engine
            wit.runActions(
              sessionId, // the user's current session
              text, // the user's message
              sessions[sessionId].context // the user's current session state
            ).then((context) => {
              // Our bot did everything it has to do.
              console.log('Waiting for next user messages')
              // Updating the user's current session state
              sessions[sessionId].context = context
            })
            .catch((err) => {
              console.error('Oops! Got an error from Wit: ', err.stack || err)
            })
            // also handle messages in the server
            messenger._handleEvent('message', event)
          } else if (event.message && event.message.attachments) {
            event.message.attachments.forEach(attachment => {
              messenger.sendApiMessage(sender, { text: 'Sorry I can only process text messages for now.' }, function (err) {
                if (err) console.error('Attachment received. unsupported behaviour.')
              })
              // also handle attachments in the server
              messenger._handleEvent(attachment.type, event) // image, audio, video, file or location
            })
          } else if (event.optin) {
            messenger._handleEvent('authentication', event)
          } else if (event.delivery) {
            messenger._handleEvent('delivery', event)
          } else if (event.postback) {
            messenger._handleEvent('postback', event)
          } else if (event.read) {
            messenger._handleEvent('read', event)
          } else if (event.account_linking && event.account_linking.status === 'linked') {
            messenger._handleEvent('accountLinked', event)
          } else if (event.account_linking && event.account_linking.status === 'unlinked') {
            messenger._handleEvent('accountUnlinked', event)
          } else {
            console.error('Webhook received an unknown messaging event: ', JSON.stringify(event))
          }
        } else {
          messenger._handleEvent('echoMessage', event)
        }
      })
    })
  }
  res.sendStatus(200)
})

messenger.on('error', function (err) {
  console.log(err.message)
})

messenger.on('signature-verified', function (response) {
  console.log(response.result)
})

messenger.on('webhook-verified', function (response) {
  console.log(response.result)
})

// listener called when a Message Event occurs.
messenger.on('message', function (event, reply) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfMessage = event.timestamp
  let message = event.message
  let mid = message.mid
  let seq = message.seq
  let text = message.text
  let key = text.split(' ')[0].toLowerCase()

  console.log(`${seq}-${mid}-${timeOfMessage}: Received message from user ${sender} and page ${recipient} with  text ${text}`)

  switch (key) {
    case 'generic':
      reply(botdata.generic, function (err, body) {
        if (err) return console.error(err)
        console.log('Generic message sent successfully')
      })
      break
    case 'image':
      reply(botdata.image, function (err, body) {
        if (err) return console.error(err)
        console.log('Image message sent successfully')
      })
      break
    case 'audio':
      reply(botdata.audio, function (err, body) {
        if (err) return console.error(err)
        console.log('Audio message sent successfully')
      })
      break
    case 'video':
      reply(botdata.video, function (err, body) {
        if (err) return console.error(err)
        console.log('Video message sent successfully')
      })
      break
    case 'file':
      reply(botdata.file, function (err, body) {
        if (err) return console.error(err)
        console.log('File message sent successfully')
      })
      break
    case 'button':
      reply(botdata.button, function (err, body) {
        if (err) return console.error(err)
        console.log('Button message sent successfully')
      })
      break
    case 'receipt':
      reply(botdata.receipt, function (err, body) {
        if (err) return console.error(err)
        console.log('Receipt message sent successfully')
      })
      break
    case 'quick':
      reply(botdata.quickReplies.normal, function (err, body) {
        if (err) return console.error(err)
        console.log('Quick normal message sent successfully')
      })
      break
    case 'quickImage':
      reply(botdata.quickReplies.withImage, function (err, body) {
        if (err) return console.error(err)
        console.log('Quick message with image sent successfully')
      })
      break
    case 'quickLocation':
      reply(botdata.quickReplies.withLocation, function (err, body) {
        if (err) return console.error(err)
        console.log('Quick message with location sent successfully')
      })
      break
    case 'itinerary':
      reply(botdata.itinerary, function (err, body) {
        if (err) return console.error(err)
        console.log('Airline Itinerary message sent successfully')
      })
      break
    case 'checkin':
      reply(botdata.checkin, function (err, body) {
        if (err) return console.error(err)
        console.log('Airline Check-In message sent successfully')
      })
      break
    case 'boardingpass':
      reply(botdata.boardingpass, function (err, body) {
        if (err) return console.error(err)
        console.log('Airline Boarding Pass message sent successfully')
      })
      break
    case 'flightupdate':
      reply(botdata.flightUpdate, function (err, body) {
        if (err) return console.error(err)
        console.log('Airline Flight update message sent successfully')
      })
      break
    default:
      /*
      reply({text: 'Echo: ' + text}, function (err, body) {
        if (err) return console.error(err)
        console.log('Echo text message sent successfully')
      })
      */
  }
})

// listener called when an Authentication Event occurs.
messenger.on('authentication', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfAuth = event.timestamp
  let passThroughParam = event.optin.ref

  console.log(`Authentication received for user ${sender} and page ${recipient} with pass-through param ${passThroughParam} at ${timeOfAuth}`)
})

// listener called when a Delivery Confirmation Event occurs.
messenger.on('delivery', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let mids = event.delivery.mids
  let watermark = event.delivery.watermark
  let seq = event.delivery.seq

  if (mids) {
    mids.forEach((mid) => {
      console.log(`Received delivery confirmation from user ${sender} and page ${recipient} with mid ${mid} and sequence #${seq}`)
    })
  }
  console.log(`All messages before ${watermark} were delivered`)
})

// listener called when a Postback Event occurs.
messenger.on('postback', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfPostback = event.timestamp
  let payload = event.postback.payload  // a developer-defined field set in a postback button
  let firstName
  let lastName
  let profilePic
  let locale
  let timezone
  let gender

  console.log(`Received postback for user ${sender} and page ${recipient} with payload ${payload} at ${timeOfPostback}`)

  // User Flow control
  if (payload === 'Start') {
    messenger.getUserProfile(sender, function (err, body) {
      if (err) return console.error(err)

      firstName = body.first_name
      lastName = body.last_name
      profilePic = body.profile_pic
      locale = body.locale
      timezone = body.timezone
      gender = body.gender

      messenger.sendApiMessage(sender, { text: 'Bienvenido ' + firstName + '! Jincana es un bot para probar las funcionalidades que ofrece Messenger Platform.\nTienes que escribir cualquiera de los siguientes comandos:' })
      messenger.sendApiMessage(sender, { text: '- generic\n- audio\n- video\n- image\n- receipt\n- quick\n- button\n- itinerary\n- boardingpass\n- checkin\n- flightupdate' })
      messenger.sendApiMessage(sender, { text: 'Si escribes cualquier otra cosa, simplemente te reenviaré tu mensaje.' })
      console.log('User Profile call was successful: %s %s with profile pic (%s), gender: %s, locale: %s and timezone: %d', firstName, lastName, profilePic, gender, locale, timezone)
    })
    console.log('Postback ' + payload + ' catched  successfully')
  } else if (payload === 'Help') {
    console.log('Postback ' + payload + ' catched  successfully')
  } else if (payload === 'Buy') {
    console.log('Postback ' + payload + ' catched  successfully')
  } else {
    console.log('Postback failed to catch')
  }
})

// listener called when a Message Account linking occurs.
messenger.on('accountLinked', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfLink = event.timestamp
  let authCode = event.account_linking.authorization_code

  console.log(`${timeOfLink}: The user ${sender} and page ${recipient} has linked his account with authorization code ${authCode}`)
})

// listener called when a Message Account unlinking occurs.
messenger.on('accountUnlinked', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfLink = event.timestamp

  console.log(`${timeOfLink}: The user ${sender} and page ${recipient} has unlinked his account`)
})

// listener called when a Message Read Event occurs.
messenger.on('read', function (event) {
  let sender = event.sender.id
  let recipient = event.recipient.id
  let timeOfRead = event.timestamp
  let watermark = event.read.watermark
  let seq = event.read.seq

  console.log(`${seq}-${timeOfRead}: All Messages were read from user ${sender} and page ${recipient} before ${watermark}`)
})

messenger.on('echoMessage', function (event) {
  console.log('Echo message received from a user')
})

messenger.on('image', function (event) {
  console.log('Image received from a user')
})

messenger.on('audio', function (event) {
  console.log('Audio received from a user')
})

messenger.on('video', function (event) {
  console.log('Video received from a user')
})

messenger.on('file', function (event) {
  console.log('File received from a user')
})

messenger.on('location', function (event) {
  console.log('Location received from a user')
})

app.listen(app.get('port'), function () {
  console.log('Node app is running on port %d', app.get('port'))

  messenger.threadSetting.setPersistentMenu(botdata.menu, function (err, body) {
    if (err) return console.error(err)
    console.log(body) // { result: "Successfully added new_thread's CTAs" }
  })

  messenger.threadSetting.setGetStartedButton('Start', function (err, body) {
    if (err) return console.error(err)
    console.log(body) // { result: "Successfully added new_thread's CTAs" }
  })
/*
  messenger.threadSetting.setGreetingText('Hi {{user_first_name}}, welcome to Jincana!', function (err, body) {
    if (err) return console.error(err)
    console.log(body) // { result: "Successfully updated greeting" }
  })
*/

  messenger.threadSetting.deleteGreetingText(function (err, body) {
    if (err) return console.error(err)
    console.log(body) // { result: "Successfully deleted greeting" }
  })

/*
  messenger.threadSetting.deleteGetStartedButton(function (err, body) {
    if (err) return console.error(err)
    console.log(body) // { result: 'Successfully deleted all new_thread\'s CTAs' }
  })
*/
/*
  messenger.threadSetting.deletePersistentMenu(function (err, body) {
    if (err) return console.error(err)

    console.log(body) // { result: 'Successfully deleted all new_thread\'s CTAs' }
  })
*/
  // messenger.threadSetting.setGreetingText('Bienvenido! Explora y encuentra más información sobre nuestros productos.')
})
