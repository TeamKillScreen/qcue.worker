var http = require('https');
var config = require('./config');

function SendSMS(number, message)
{
	//The url we want is: 'www.random.org/integers/?num=1&min=1&max=10&col=1&base=10&format=plain&rnd=new'
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

SendSMS('', 'Hello+World')