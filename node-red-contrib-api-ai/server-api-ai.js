const helper  = require('node-red-viseo-helper')
const botmgr  = require('node-red-viseo-bot-manager')
let ApiAiApp = require('actions-on-google').ApiAiApp;
const CARRIER = "GoogleHome"

const userManager = require('./lib/user.js');

// --------------------------------------------------------------------------
//  NODE-RED
// --------------------------------------------------------------------------

module.exports = function(RED) {
    const register = function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        start(RED, node, config);
        this.on('close', (done)  => { stop(node, config, done) });
    }
    RED.nodes.registerType("api-ai-server", register, {
        credentials: {
            clientId:   { type: "text" },
            projectId:  { type: "text" },
            secretKey:  { type: "text" }
        }
    });
}

let LISTENERS = {};
const start = (RED, node, config) => {  

    // Start HTTP Route
    let uri = '/api-ai-server/'; 

    //Authentication for api ai
    if(! node.credentials.clientId || !node.credentials.secretKey || ! node.credentials.projectId) {
        node.status({ fill: "red", shape: "dot", text: "Client ID, Project ID and Client Secret are mandatory for Api AI Server" })
        //return;
    }

    node.status({});
    userManager.Authentication(RED.httpNode, uri, node.credentials.projectId, node.credentials.clientId, node.credentials.secretKey, function(user) {
        let data = {
            user: user
        };

        console.log(user);

        node.send([data, undefined]);
    });


    node.warn('Add GET/POST route to: '+ uri);
    RED.httpNode.post (uri, (req, res, next) => { receive(node, config, req, res); });

    // Add listener to reply
    let listener = LISTENERS[node.id] = (srcNode, data, srcConfig) => { reply(node, data, config) }
    helper.listenEvent('reply', listener)

}

const stop = (node, config, done) => {
    let listener = LISTENERS[node.id]
    helper.removeListener('reply', listener)
    done();
}

// ------------------------------------------
//  RECEIVE
// ------------------------------------------

const receive = (node, config, req, res) => { 
    console.log("receive");
    let json = req.body
    node.warn(json);
    // try { json = JSON.parse(json); } catch (ex) { console.log('Parsing Error', ex, json) }

    if(json.originalRequest == undefined) {
        console.log(json);
        node.warn('Empty request received');
        return;
    }

    let data = botmgr.buildMessageFlow({ message : json }, {
        userLocale: 'message.originalRequest.data.user.locale',
        userId:     'message.originalRequest.data.user.userId', 
        convId:     'message.originalRequest.data.conversation.conversationId',
        payload:    'message.originalRequest.data.inputs[0].rawInputs[0].query',
        inputType:  'message.originalRequest.data.inputs[0].rawInputs[0].inputType',
        source:     CARRIER
    })

    data.user.accessToken = data.message.originalRequest.data.user.accessToken;



    let context = botmgr.getContext(data)
    context.req = req
    context.res = res

    if(json.originalRequest.data.inputs[0].arguments !== undefined && json.originalRequest.data.inputs[0].arguments.length > 0) {
        data.message.text = json.originalRequest.data.inputs[0].arguments[0].textValue
    }

    // Handle Prompt
    let convId  = helper.getByString(data, 'user.address.conversation.id', undefined)
    if (botmgr.hasDelayedCallback(convId, data.message)) return;

    // Trigger received message
    helper.emitEvent('received', node, data, config);
    node.warn('>>> RECEIVE <<<')
    node.warn(data);
    node.send([undefined, data]);

}

// ------------------------------------------
//  REPLY
// ------------------------------------------

const reply = (node, data, config) => { 
    node.warn('>>> REPLY <<<')
    try {
        // The address is not used because we reply to HTTP Response
        let context = botmgr.getContext(data)
        let res = context.res


        // Assume we send the message to the current user address
        let address = botmgr.getUserAddress(data)
        if (!address || address.carrier !== CARRIER) return false;

        // Building the message
        node.warn(data.reply);
        let message = getMessage(data.reply, context);

        if (!message) return false;
        /*if(data.reply[0].type === "signin") {
            console.log('already sent sign in');
            return;
        }*/
        
        res.setHeader('Content-Type', 'application/json');

        // Write the message to the response
        res.end(JSON.stringify(message));
        node.warn(message);

        // Trap the event in order to continue
        helper.fireAsyncCallback(data);

    } catch(ex){ console.log(ex) }
}

// ------------------------------------------
//  MESSAGES
//  https://github.com/api-ai/fulfillment-webhook-nodejs/blob/master/functions/index.js
// ------------------------------------------

// https://api.ai/docs/fulfillment#response
const getMessage = exports.getMessage = (replies, context) => { 

    if (!replies) return;
    let msg = {}

    // Data source
    msg.source = 'VISEO'

    // Response to the request.
    msg.speech = '';

    // Text displayed on the user device screen.
    msg.displayText = '';

    // Specific data for Google
    msg.data = {};
    msg.data.google = getGoogleMessage(replies, context);

    // Array of context objects set after intent completion. Example: 
    // msg.contextOut = [{"name":"weather", "lifespan":2, "parameters":{"city":"Rome"}}]

    // Event name and optional parameters sent from the web service to API.AI.
    // msg.followupEvent = {"name":"<event_name>","data":{"<parameter_name>":"<parameter_value>"}}

    return msg;
}

const getGoogleMessage = exports.getGoogleMessage = (replies, context) => {
    if (!replies) return;

    // Build a sur message for Google
    let google = {}

    // An opaque token that is recirculated to the app every conversation turn. Not use by API.ai !
    // google.conversationToken = ''

    // Indicates whether the app is expecting a user response. 
    // This is true when the conversation is ongoing, false when the conversation is done.
    google.expectUserResponse = false
    //for (let reply of replies){ 
    //    if (reply.prompt) { 
            google.expectUserResponse = true 
    //    }
    //}

    // Indicates whether the text to speech is SSML or not.
    google.isSsml = false

    // The textToSpeech field in a SimpleResponse
    // google.speech = '';

    // Prompt used to ask user when there is no input from user. it's a SimpleResponse !
    google.noInputPrompts = []

    // A RichResponse in an expectedInputs.inputPrompt.richInitialPrompt
    google.richResponse = {
      items: []
    }

    // The final response when the user input is not expected. It's a RichResponse !
    // google.finalResponse = {}

    let reply = replies[0]
            
    
    // SimpleResponse (always one at first)
    // https://developers.google.com/actions/reference/rest/Shared.Types/AppResponse#simpleresponse
    let simple = {};
    google.richResponse.items.push({'simpleResponse' : simple})

    let text = reply.text || reply.quicktext || (reply.title + ' ' + (reply.subtitle||''))
    simple.displayText = text      // (optional) chat bubble 640 chars. max
    if (reply.speech === true){
        simple.textToSpeech = text // plain text exclusive with ssml
    } else {
        simple.ssml = reply.speech // Structured spoken response to the user in the SSML format
    }

    // Carousel of cards
    if (replies.length > 1){
        let carousel = { items : [] }
        google.systemIntent = {
            intent: "actions.intent.OPTION",
            data: {
                "@type":"type.googleapis.com/google.actions.v2.OptionValueSpec"
            }
        }
        google.systemIntent.data.carouselSelect = carousel;

        for (let card of replies){
            let item = {};
            carousel.items.push(item)
            item.title = card.title
            item.description = card.subtitle || ''
            if (card.attach){ item.image = { url: helper.absURL(card.attach) } }

            // A unique key that will be sent back to the agent if this response is given.
            // https://developers.google.com/actions/reference/rest/Shared.Types/OptionInfo
            item.optionInfo = { key: card.title, synonyms: [] }
            if (card.buttons){
                let button = card.buttons[0];
                if ("string" === typeof button) {
                    item.optionInfo.key = button
                } else {
                    item.optionInfo.key = button.value
                    item.optionInfo.synonyms.push(button.title)
                }
            }
        }
        return google;
    }


    if (reply.type === 'signin'){

       /* const app = new ApiAiApp({request: context.req, response: context.res});
        const actionMap = new Map();
        actionMap.set('sign.in', function(app) {
            console.log(app.getSignInStatus());
        });

        app.handleRequest(actionMap);

        app.askForSignIn();

        return;*/
            
        google.systemIntent = {
            intent : "actions.intent.SIGN_IN",
            data : {}
        };
        /* ASK for name
        google.systemIntent = {
            intent: "actions.intent.PERMISSION",
            data: {
                "@type":"type.googleapis.com/google.actions.v2.PermissionValueSpec",
                "optContext": "test",
                "permissions": [
                    "NAME"
                ]
            }
        };*/

        return google;
    }

    // BasicCard
    // https://developers.google.com/actions/reference/rest/Shared.Types/AppResponse#BasicCard
    if (reply.type === 'media' || reply.type === 'card') {
        let item = {};
        google.richResponse.items.push({'basicCard' : item})

        if (reply.title){      item.title    = reply.title }
        if (reply.subtitle){   item.subtitle = reply.subtitle }
        if (reply.text){       item.formattedText = reply.text }
        if (reply.quicktext){  item.formattedText = reply.quicktext }

        // Require an Image or formatedText
        if (reply.media || reply.attach) {
            item.image = reply.media ? { url: helper.absURL(reply.media) } : { url: helper.absURL(reply.attach) }
        } else if (!item.formattedText){
            if (item.subtitle){
                item.formattedText = item.subtitle
                item.subtitle = undefined
            } else if (item.title) {
                item.formattedText = item.title
                item.title = undefined
            }
        }
        
        if (reply.buttons){
            item.buttons = [];
            for (let btn of reply.buttons){
                if (btn.action !== 'openUrl') continue;
                item.buttons.push({
                    title: btn.title,
                    openUrlAction: { url: helper.absURL(btn.value) }
                })
            }
        }

        
    }

    if (reply.type === 'quick'){
        google.richResponse.suggestions = [];
         // A unique key that will be sent back to the agent if this response is given.
        // https://developers.google.com/actions/reference/rest/Shared.Types/OptionInfo
        for (let button of reply.buttons){

            if(button.action === 'askLocation') {
                google.systemIntent = {
                    intent: "actions.intent.PERMISSION",
                    data: {
                        "@type":"type.googleapis.com/google.actions.v2.PermissionValueSpec",
                        "optContext": button.title,
                        "permissions": [
                            "DEVICE_PRECISE_LOCATION"
                        ]
                    }
                };
                return google;
            }

            let btn = {}

            google.richResponse.suggestions.push(btn);

            if ("string" === typeof button) {
                btn.title = button
               // btn.optionInfo = { key: button, synonyms: [button] }
            } else {
                btn.title = button.title
                //btn.optionInfo = { key: button.value, synonyms: [button.title] }
            }
            // btn.description = ''
            // btn.image = ''
        }


    }

    return google;
}