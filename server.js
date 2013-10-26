require('log-timestamp');

var http = require('https');
var config = require('./config');
var Firebase = require('firebase');

var tasksRef = new Firebase(config.TasksFirebaseURL);
var queuesRef = new Firebase(config.QueuesFirebaseURL);

var managedQueues = [];

function SendSMS(number, message)
{
	var options = {
	  host: 'api.clockworksms.com',
	  path: '/http/send.aspx?key=' + config.ClockworkSMSKey + '&to=' + number + '&content=' + message
	};

	callback = function(response) {
	  var str = '';

	  //another chunk of data has been recieved, so append it to `str`
	  response.on('data', function (chunk) {
		str += chunk;
	  });

	  //the whole response has been recieved, so we just print it out here
	  response.on('end', function () {
		console.log(str);
	  });
	}

	http.request(options, callback).end();
}

console.log("Worker initialising")

tasksRef.on('child_added', function(snapshot) {
  //console.log(snapshot)

  item = snapshot.val();

  var processed = item.processed, task = item.task, payload = item.payload;
  if(!processed)
  {
	switch(task)
	{
		case 'sms':
			console.log('Received SMS task. Number: ' + payload.mobile);
			SendSMS(payload.mobile, payload.message)
			break;
		default:
			console.log('Unknown task: ' + task);
			break;

		
	}

	snapshot.ref().remove();
  }
  
});

queuesRef.on('child_added', function(snapshot) {
	item = snapshot.val();

	if(item.type == 'automated')
	{
		console.log('Found automated queue ' + item.name + '. Monitoring')

		managedQueues.push({queue: snapshot.ref(), timer: item.gap, lastChecked: new Date()});
	}
});

console.log("Worker initialised");

setInterval(function() {
	//console.log("Checking automated queues")

	var length = managedQueues.length,
		element = null;
	for (var i = 0; i < length; i++)
	{
		element = managedQueues[i];
	  
		//console.log(element);

		var now = new Date();
		var diffTime = now.getTime() - element.lastChecked.getTime();

		//console.log(diffTime);

		if(diffTime > element.timer * 1000)
		{
			//Mark last checked as now
			element.lastChecked = now;

			//Get the item from firebase
			element.queue.once('value', function(snapshot) {

				item = snapshot.val();

				startDate = new Date(item.queueStart);

				if(startDate < new Date())
				{
					console.log("Processing queue: " + item.name);
				}
				else
				{
					console.log("Queue not started: " + item.name);
				}

				//DO STUFF

				//Update local timer cache
				element.timer = item.gap;
			});

		}
	}
}, 1000)

